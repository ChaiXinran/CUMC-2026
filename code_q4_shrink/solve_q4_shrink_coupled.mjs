import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';
import {
  R0,
  H_T,
  H_M,
  T0,
  C0,
  gridForCoordinate,
  coupledStepQ4,
  makeRadiusModel,
  simulateQuestion4,
} from '../code_q4/solve_q4_refined.mjs';

const THRESHOLD_C = 0.15;
const DEFAULT_T_END = 600000;
const DEFAULT_CONFIG = 'code_q4_shrink/shrink_coupled_config.json';
const DEFAULT_OUTPUT_ROOT = 'code_q4_shrink/runs';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environmentInputPath = path.join(projectRoot, 'CUMCM2026Problems', 'A题', '附件', '附件1.xlsx');
const radiusInputPath = path.join(projectRoot, 'CUMCM2026Problems', 'A题', '附件', '附件2.xlsx');

function maxAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error('数组长度不一致');
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

function sumWeighted(grid, state) {
  let total = 0;
  for (let i = 0; i <= grid.n; i++) total += grid.weights[i] * state[i];
  return total;
}

function maxAndIndex(values) {
  let index = 0;
  let value = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] > value) {
      value = values[i];
      index = i;
    }
  }
  return { value, index };
}

function heatCapacityQ4(c) {
  if (!(c > 0) || !Number.isFinite(c)) throw new Error(`热容量输入非法: ${c}`);
  return (760 + 90 * c) * (1850 + 2150 * c / (1 + c));
}

function linearInterpolatePoints(points, time) {
  if (time <= points[0][0]) return points[0][1];
  if (time >= points[points.length - 1][0]) return points[points.length - 1][1];
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid][0] <= time) lo = mid;
    else hi = mid;
  }
  const w = (time - points[lo][0]) / (points[hi][0] - points[lo][0]);
  return points[lo][1] * (1 - w) + points[hi][1] * w;
}

function trapezoidalWindowMean(rows, column, windowSeconds) {
  const lastTime = rows[rows.length - 1][0];
  const startTime = lastTime - windowSeconds;
  let integral = 0;
  let duration = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const t0 = Math.max(startTime, rows[i][0]);
    const t1 = Math.min(lastTime, rows[i + 1][0]);
    if (!(t1 > t0)) continue;
    const y0 = linearInterpolatePoints(rows.map((row) => [row[0], row[column]]), t0);
    const y1 = linearInterpolatePoints(rows.map((row) => [row[0], row[column]]), t1);
    integral += 0.5 * (y0 + y1) * (t1 - t0);
    duration += t1 - t0;
  }
  if (Math.abs(duration - windowSeconds) > 1e-8) throw new Error(`环境窗口积分时长异常: ${duration}`);
  return integral / duration;
}

function makeEnvironment(rows, windowSeconds) {
  const clean = rows
    .map((row) => [Number(row[0]), Number(row[1]), Number(row[2])])
    .filter((row) => row.every((value) => Number.isFinite(value)))
    .sort((a, b) => a[0] - b[0]);
  if (clean.length !== 241) throw new Error(`附件1有效点数不是241: ${clean.length}`);
  const temperaturePoints = clean.map((row) => [row[0], row[1]]);
  const moisturePoints = clean.map((row) => [row[0], row[2]]);
  const lastTime = clean[clean.length - 1][0];
  const endpoint = clean[clean.length - 1];
  const mean = {
    temperature: trapezoidalWindowMean(clean, 1, windowSeconds),
    moisture: trapezoidalWindowMean(clean, 2, windowSeconds),
  };
  const windowStart = lastTime - windowSeconds;
  const windowPointCount = clean.filter((row) => row[0] >= windowStart - 1e-8).length;
  return {
    extension: 'lastWindowMean',
    windowSeconds,
    windowStart,
    windowMethod: 'trapezoidal',
    windowPointCount,
    lastTime,
    endpoint: { temperature: endpoint[1], moisture: endpoint[2] },
    lastWindowMean: mean,
    temperaturePoints,
    moisturePoints,
    temperature: (time) => time <= lastTime ? linearInterpolatePoints(temperaturePoints, time) : mean.temperature,
    moisture: (time) => time <= lastTime ? linearInterpolatePoints(moisturePoints, time) : mean.moisture,
  };
}

async function loadInputs(windowSeconds) {
  const environmentWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(environmentInputPath));
  const environmentRows = environmentWorkbook.worksheets.getItemAt(0).getUsedRange(true).values.slice(1);
  const environment = makeEnvironment(environmentRows, windowSeconds);
  const radiusWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(radiusInputPath));
  const radiusRows = radiusWorkbook.worksheets.getItemAt(0).getUsedRange(true).values.slice(1);
  const pchip = makeRadiusModel(radiusRows, 'pchip');
  return { environment, radiusRows, pchip };
}

function observationTimes(radiusModel) {
  return radiusModel.points.map(([time]) => time);
}

function meanLastPoints(points, count) {
  const selected = points.slice(-count);
  return selected.reduce((sum, point) => sum + point[1], 0) / selected.length;
}

function buildShrinkLaw(radiusModel, environment, p, tailCount) {
  if (!(p > 0) || !Number.isFinite(p)) throw new Error(`p必须为正: ${p}`);
  const rTail = meanLastPoints(radiusModel.points, tailCount);
  const lambda = (rTail / R0) ** 2;
  const Ce = environment.lastWindowMean.moisture;
  const denominator = C0 - Ce;
  if (!(lambda > 0 && lambda < 1)) throw new Error(`lambda非法: ${lambda}`);
  if (!(denominator > 0)) throw new Error(`含水率标度非法: C0=${C0}, Ce=${Ce}`);
  const fromCbar = (cbar) => {
    const mr = (cbar - Ce) / denominator;
    if (!Number.isFinite(mr) || mr < 0 || mr > 1 + 1e-10) {
      throw new Error(`MR越界: Cbar=${cbar}, Ce=${Ce}, MR=${mr}, p=${p}`);
    }
    const squaredRadius = lambda + (1 - lambda) * (mr ** p);
    if (!(squaredRadius > 0) || !Number.isFinite(squaredRadius)) throw new Error(`半径平方非法: ${squaredRadius}`);
    return { radius: R0 * Math.sqrt(squaredRadius), cbar, mr };
  };
  return {
    p,
    Ce,
    rTail,
    tailCount,
    lambda,
    lambdaMethod: `last_${tailCount}_observed_points_arithmetic_mean`,
    fromCbar,
  };
}

function geometryFromState(grid, moisture, law) {
  return law.fromCbar(2 * sumWeighted(grid, moisture));
}

function coupledShrinkStep(grid, oldTemperature, oldMoisture, dt, environment, law, options = {}) {
  const outerMaxIterations = options.outerMaxIterations ?? 80;
  const outerRelaxation = options.outerRelaxation ?? 0.65;
  const radiusUpdateTolerance = options.radiusUpdateTolerance ?? 1e-11;
  const temperatureUpdateTolerance = options.temperatureUpdateTolerance ?? 1e-8;
  const moistureUpdateTolerance = options.moistureUpdateTolerance ?? 1e-10;
  const residualTolerance = options.residualTolerance ?? 1e-8;
  const innerMaxIterations = options.innerMaxIterations ?? 100;
  let outerTemperature = oldTemperature.slice();
  let outerMoisture = oldMoisture.slice();
  let radius = geometryFromState(grid, oldMoisture, law).radius;
  let lastInner = null;
  let lastRadiusConsistency = Infinity;
  let lastTemperatureUpdate = Infinity;
  let lastMoistureUpdate = Infinity;
  for (let outerIteration = 1; outerIteration <= outerMaxIterations; outerIteration++) {
    const inner = coupledStepQ4(
      grid,
      oldTemperature,
      oldMoisture,
      dt,
      environment,
      {
        physics: 'q4',
        kind: 'material',
        radius,
        heatExchangeCoefficient: H_T,
        moistureExchangeCoefficient: H_M,
        maxIterations: innerMaxIterations,
        temperatureUpdateTolerance,
        moistureUpdateTolerance,
        residualTolerance,
        relaxation: options.innerRelaxation ?? 0.8,
      },
    );
    const nextTemperature = outerTemperature.map((value, i) => value + outerRelaxation * (inner.temperature[i] - value));
    const nextMoisture = outerMoisture.map((value, i) => value + outerRelaxation * (inner.moisture[i] - value));
    if (nextMoisture.some((value) => !(value > 0) || !Number.isFinite(value))) throw new Error('耦合外迭代得到非法含水率');
    if (nextTemperature.some((value) => !Number.isFinite(value) || value + 273.15 <= 0)) throw new Error('耦合外迭代得到非法温度');
    const geometry = geometryFromState(grid, nextMoisture, law);
    const nextRadius = radius + outerRelaxation * (geometry.radius - radius);
    lastTemperatureUpdate = maxAbsDiff(nextTemperature, outerTemperature);
    lastMoistureUpdate = maxAbsDiff(nextMoisture, outerMoisture);
    lastRadiusConsistency = Math.abs(nextRadius - geometry.radius);
    outerTemperature = nextTemperature;
    outerMoisture = nextMoisture;
    radius = nextRadius;
    lastInner = inner;
    if (
      lastTemperatureUpdate <= temperatureUpdateTolerance &&
      lastMoistureUpdate <= moistureUpdateTolerance &&
      lastRadiusConsistency <= radiusUpdateTolerance &&
      inner.temperatureResidual.scaled <= residualTolerance &&
      inner.moistureResidual.scaled <= residualTolerance
    ) {
      const finalGeometry = geometryFromState(grid, outerMoisture, law);
      return {
        temperature: outerTemperature,
        moisture: outerMoisture,
        radius: radius,
        cbar: finalGeometry.cbar,
        mr: finalGeometry.mr,
        outerIterations: outerIteration,
        innerIterations: inner.iterations,
        temperatureUpdate: lastTemperatureUpdate,
        moistureUpdate: lastMoistureUpdate,
        radiusUpdate: lastRadiusConsistency,
        radiusConsistency: Math.abs(radius - finalGeometry.radius),
        temperatureResidual: inner.temperatureResidual,
        moistureResidual: inner.moistureResidual,
      };
    }
  }
  throw new Error(`含水率-半径外迭代未收敛: T=${lastTemperatureUpdate}, C=${lastMoistureUpdate}, R=${lastRadiusConsistency}, inner=${lastInner?.iterations}`);
}

function outputTimes(tEnd, interval) {
  const times = [];
  for (let t = 0; t <= tEnd + 1e-8; t += interval) times.push(Number(Math.min(t, tEnd).toFixed(8)));
  if (times[times.length - 1] < tEnd - 1e-8) times.push(tEnd);
  return [...new Set(times)];
}

function defaultCheckpointTimes(tEnd, interval = 21600) {
  return outputTimes(tEnd, interval);
}

function emptyCoupledStore() {
  return { times: [], radius: [], cbar: [], mr: [], meanMoisture: [], maximumMoisture: [], maximumMoistureIndex: [], surfaceMoisture: [], surfaceTemperature: [] };
}

function recordCoupled(store, time, grid, temperature, moisture, radius, cbar, mr) {
  const maximum = maxAndIndex(moisture);
  store.times.push(time);
  store.radius.push(radius);
  store.cbar.push(cbar);
  store.mr.push(mr);
  store.meanMoisture.push(cbar);
  store.maximumMoisture.push(maximum.value);
  store.maximumMoistureIndex.push(maximum.index);
  store.surfaceMoisture.push(moisture[grid.n]);
  store.surfaceTemperature.push(temperature[grid.n]);
}

function stageUpdate(stageCrossings, oldMaximum, newMaximum, oldTime, dt) {
  for (const threshold of [0.6, 0.3, 0.2, 0.15]) {
    if (stageCrossings[threshold] === undefined && oldMaximum > threshold && newMaximum <= threshold) {
      const fraction = (threshold - oldMaximum) / (newMaximum - oldMaximum);
      stageCrossings[threshold] = oldTime + Math.max(0, Math.min(1, fraction)) * dt;
    }
  }
}

function refineCoupledThreshold(grid, oldTemperature, oldMoisture, leftTime, rightTime, environment, law, options) {
  let lo = leftTime;
  let hi = rightTime;
  let hiStep = null;
  for (let iteration = 0; iteration < 30 && hi - lo > 1e-3; iteration++) {
    const mid = 0.5 * (lo + hi);
    const values = { time: mid, temperature: environment.temperature(mid), moisture: environment.moisture(mid) };
    const step = coupledShrinkStep(grid, oldTemperature, oldMoisture, mid - leftTime, values, law, options);
    if (Math.max(...step.moisture) < THRESHOLD_C) {
      hi = mid;
      hiStep = step;
    } else {
      lo = mid;
    }
  }
  if (!hiStep) {
    const values = { time: hi, temperature: environment.temperature(hi), moisture: environment.moisture(hi) };
    hiStep = coupledShrinkStep(grid, oldTemperature, oldMoisture, hi - leftTime, values, law, options);
  }
  return { time: hi, step: hiStep, bracket: [lo, hi] };
}

function simulateCoupledShrink(environment, law, options = {}) {
  const n = options.n ?? 80;
  const requestedDt = options.dt ?? 4;
  const tEnd = options.tEnd ?? DEFAULT_T_END;
  const outputInterval = options.outputInterval ?? 1800;
  const requestedTimes = options.storeTimes ?? outputTimes(tEnd, outputInterval);
  const checkpointTimes = [...new Set((options.checkpointTimes ?? defaultCheckpointTimes(tEnd, 21600)).filter((time) => time >= 0 && time <= tEnd + 1e-8))].sort((a, b) => a - b);
  const grid = gridForCoordinate(n, 1, options.mesh ?? 'surfaceRefined');
  let temperature = options.initialTemperature?.slice() ?? new Array(n + 1).fill(T0);
  let moisture = options.initialMoisture?.slice() ?? new Array(n + 1).fill(C0);
  const store = emptyCoupledStore();
  const stateCheckpoints = [];
  const balance = {
    initialMoistureIntegral: sumWeighted(grid, moisture),
    cumulativeBoundaryMoistureOutflow: 0,
    cumulativeBoundaryHeatOutflow: 0,
    initialThermalStorage: sumWeighted(grid, moisture.map((c, i) => heatCapacityQ4(c) * temperature[i])),
    cumulativeThermalStorageChange: 0,
    maxOuterIterations: 0,
    maxInnerIterations: 0,
    maxTemperatureResidual: 0,
    maxMoistureResidual: 0,
    maxRadiusConsistency: 0,
    maxMR: -Infinity,
    minMR: Infinity,
    acceptedSteps: 0,
    rejectedSteps: 0,
    minAcceptedDt: Infinity,
    maxAcceptedDt: 0,
    minTemperature: Math.min(...temperature),
    maxTemperature: Math.max(...temperature),
    minMoisture: Math.min(...moisture),
    maxMoisture: Math.max(...moisture),
  };
  let t = 0;
  let dt = requestedDt;
  let outputIndex = 0;
  let checkpointIndex = 0;
  const progressRecords = [];
  const progressIntervalSeconds = options.progressIntervalSeconds ?? 21600;
  let nextProgressTime = progressIntervalSeconds;
  let previousMaximum = Math.max(...moisture);
  let thresholdEvent = null;
  const stageCrossings = {};
  const radius0Geometry = geometryFromState(grid, moisture, law);
  const recordCheckpoint = (time, step, type = 'scheduled') => {
    stateCheckpoints.push({ time, type, radius: step.radius, cbar: step.cbar, mr: step.mr, temperature: step.temperature.slice(), moisture: step.moisture.slice(), maximumMoisture: Math.max(...step.moisture), maximumMoistureIndex: maxAndIndex(step.moisture).index });
  };
  const recordProgress = (time, step, type = 'interval') => {
    const record = {
      type,
      time_s: time,
      time_h: time / 3600,
      acceptedSteps: balance.acceptedSteps,
      rejectedSteps: balance.rejectedSteps,
      radius_m: step.radius,
      cbar: step.cbar,
      mr: step.mr,
      maximumMoisture: Math.max(...step.moisture),
      outerIterations: step.outerIterations ?? null,
      innerIterations: step.innerIterations ?? null,
      temperatureResidual: step.temperatureResidual?.scaled ?? null,
      moistureResidual: step.moistureResidual?.scaled ?? null,
      radiusConsistency: step.radiusConsistency ?? null,
    };
    progressRecords.push(record);
    const label = options.progressLabel ?? 'coupled';
    console.log(`[coupled-progress] ${label} t=${record.time_h.toFixed(3)} h accepted=${record.acceptedSteps} rejected=${record.rejectedSteps} R=${(record.radius_m * 100).toFixed(6)} cm Cbar=${record.cbar.toFixed(6)} maxC=${record.maximumMoisture.toFixed(6)} outer=${record.outerIterations ?? '—'} inner=${record.innerIterations ?? '—'}`);
    if (options.progressPath) fsSync.appendFileSync(options.progressPath, `${JSON.stringify(record)}\n`, 'utf8');
  };
  const accept = (oldTemperature, oldMoisture, step, dtUsed, env) => {
    const moistureExchange = H_M / step.radius;
    const heatExchange = H_T / step.radius;
    balance.cumulativeBoundaryMoistureOutflow += dtUsed * moistureExchange * (step.moisture[grid.n] - env.moisture);
    balance.cumulativeBoundaryHeatOutflow += dtUsed * heatExchange * (step.temperature[grid.n] - env.temperature);
    balance.cumulativeThermalStorageChange += sumWeighted(grid, step.temperature.map((value, i) => heatCapacityQ4(step.moisture[i]) * (value - oldTemperature[i])));
    balance.maxOuterIterations = Math.max(balance.maxOuterIterations, step.outerIterations);
    balance.maxInnerIterations = Math.max(balance.maxInnerIterations, step.innerIterations);
    balance.maxTemperatureResidual = Math.max(balance.maxTemperatureResidual, step.temperatureResidual.scaled);
    balance.maxMoistureResidual = Math.max(balance.maxMoistureResidual, step.moistureResidual.scaled);
    balance.maxRadiusConsistency = Math.max(balance.maxRadiusConsistency, step.radiusConsistency);
    balance.maxMR = Math.max(balance.maxMR, step.mr);
    balance.minMR = Math.min(balance.minMR, step.mr);
    balance.acceptedSteps++;
    balance.minAcceptedDt = Math.min(balance.minAcceptedDt, dtUsed);
    balance.maxAcceptedDt = Math.max(balance.maxAcceptedDt, dtUsed);
    balance.minTemperature = Math.min(balance.minTemperature, ...step.temperature);
    balance.maxTemperature = Math.max(balance.maxTemperature, ...step.temperature);
    balance.minMoisture = Math.min(balance.minMoisture, ...step.moisture);
    balance.maxMoisture = Math.max(balance.maxMoisture, ...step.moisture);
  };
  const recordDue = (time, step) => {
    while (outputIndex < requestedTimes.length && requestedTimes[outputIndex] <= time + 1e-8) {
      if (Math.abs(requestedTimes[outputIndex] - time) > 1e-8) throw new Error(`输出时间未准确落点: ${requestedTimes[outputIndex]} vs ${time}`);
      recordCoupled(store, time, grid, step.temperature, step.moisture, step.radius, step.cbar, step.mr);
      outputIndex++;
    }
  };
  const recordInitial = { temperature, moisture, radius: radius0Geometry.radius, cbar: radius0Geometry.cbar, mr: radius0Geometry.mr };
  recordDue(0, recordInitial);
  if (options.progressPath) recordProgress(0, recordInitial, 'initial');
  while (checkpointIndex < checkpointTimes.length && Math.abs(checkpointTimes[checkpointIndex]) < 1e-8) {
    recordCheckpoint(0, recordInitial);
    checkpointIndex++;
  }
  while (t < tEnd - 1e-10) {
    const target = requestedTimes[outputIndex] ?? tEnd;
    const dtStep = Math.min(dt, target - t, tEnd - t);
    if (!(dtStep > 0)) {
      if (Math.abs(target - t) < 1e-8) { outputIndex++; continue; }
      throw new Error(`耦合模型时间推进目标异常: t=${t}, target=${target}`);
    }
    const oldTime = t;
    const oldTemperature = temperature;
    const oldMoisture = moisture;
    const oldMaximum = previousMaximum;
    try {
      const nextTime = oldTime + dtStep;
      const values = { time: nextTime, temperature: environment.temperature(nextTime), moisture: environment.moisture(nextTime) };
      let step = coupledShrinkStep(grid, oldTemperature, oldMoisture, dtStep, values, law, options);
      let dtUsed = dtStep;
      const newMaximum = Math.max(...step.moisture);
      if (!thresholdEvent && oldMaximum > THRESHOLD_C && newMaximum <= THRESHOLD_C) {
        const refined = refineCoupledThreshold(grid, oldTemperature, oldMoisture, oldTime, nextTime, environment, law, options);
        step = refined.step;
        dtUsed = refined.time - oldTime;
        thresholdEvent = { bracket: refined.bracket, confirmedTime: refined.time, confirmedMaximum: Math.max(...step.moisture), confirmedIndex: maxAndIndex(step.moisture).index, criterion: 'max over all internal x nodes < 0.15 kg/kg' };
        stageUpdate(stageCrossings, oldMaximum, Math.max(...step.moisture), oldTime, dtUsed);
        stageCrossings[THRESHOLD_C] = refined.time;
      } else {
        stageUpdate(stageCrossings, oldMaximum, newMaximum, oldTime, dtStep);
      }
      accept(oldTemperature, oldMoisture, step, dtUsed, values);
      t = oldTime + dtUsed;
      temperature = step.temperature;
      moisture = step.moisture;
      previousMaximum = Math.max(...moisture);
      recordDue(t, step);
      if (t >= nextProgressTime - 1e-8 || (thresholdEvent && options.stopAtThreshold)) {
        recordProgress(t, step, thresholdEvent ? 'threshold' : 'interval');
        while (nextProgressTime <= t + 1e-8) nextProgressTime += progressIntervalSeconds;
      }
      while (checkpointIndex < checkpointTimes.length && checkpointTimes[checkpointIndex] <= t + 1e-8) {
        if (Math.abs(checkpointTimes[checkpointIndex] - t) > 1e-8) throw new Error(`检查点时间未准确落点: ${checkpointTimes[checkpointIndex]} vs ${t}`);
        recordCheckpoint(t, step);
        checkpointIndex++;
      }
      dt = Math.min(requestedDt, dt * 2);
      if (options.stopAtThreshold && thresholdEvent) break;
    } catch (error) {
      if (dt <= requestedDt / (options.stepReductionLimit ?? 128)) throw error;
      dt *= 0.5;
      balance.rejectedSteps++;
    }
  }
  const finalGeometry = geometryFromState(grid, moisture, law);
  const lastState = { time: t, temperature: temperature.slice(), moisture: moisture.slice(), radius: finalGeometry.radius, cbar: finalGeometry.cbar, mr: finalGeometry.mr };
  if (options.progressPath && (!progressRecords.length || Math.abs(progressRecords[progressRecords.length - 1].time_s - t) > 1e-8)) recordProgress(t, lastState, thresholdEvent ? 'threshold_final' : 'final');
  if (!checkpointTimes.some((time) => Math.abs(time - t) < 1e-8)) recordCheckpoint(t, lastState, thresholdEvent ? 'threshold' : 'budget');
  balance.finalMoistureIntegral = sumWeighted(grid, moisture);
  balance.integralMoistureLoss = balance.initialMoistureIntegral - balance.finalMoistureIntegral;
  balance.moistureBalanceError = balance.integralMoistureLoss - balance.cumulativeBoundaryMoistureOutflow;
  balance.moistureBalanceErrorRelative = balance.moistureBalanceError / Math.max(1e-30, Math.abs(balance.initialMoistureIntegral));
  balance.thermalStorageBalanceError = balance.cumulativeThermalStorageChange + balance.cumulativeBoundaryHeatOutflow;
  balance.thermalStorageBalanceErrorRelative = balance.thermalStorageBalanceError / Math.max(1, Math.abs(balance.initialThermalStorage));
  balance.finalTime = t;
  balance.finalRadius = finalGeometry.radius;
  balance.thresholdEvent = thresholdEvent;
  return { grid, requestedDt, outputInterval, store, stateCheckpoints, progressRecords, balance, thresholdEvent, stageCrossings, lastState, finalRadius: finalGeometry.radius, law };
}

function indexSplit(count, validationBlocks, tailCount) {
  const validation = new Set();
  for (const [start, end] of validationBlocks) for (let i = start; i <= end; i++) if (i >= 0 && i < count - tailCount) validation.add(i);
  const tail = new Set(Array.from({ length: tailCount }, (_, j) => count - tailCount + j));
  const train = [];
  for (let i = 0; i < count; i++) if (!validation.has(i) && !tail.has(i)) train.push(i);
  return { train, validation: [...validation].sort((a, b) => a - b), tail: [...tail].sort((a, b) => a - b) };
}

function residualMetrics(predicted, observed, indices) {
  const residuals = indices.map((index) => predicted[index] - observed[index]);
  const rmse = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / Math.max(1, residuals.length));
  return { count: residuals.length, rmse, maxAbs: residuals.reduce((max, value) => Math.max(max, Math.abs(value)), 0), sse: residuals.reduce((sum, value) => sum + value * value, 0), residuals };
}

function stageName(timeSeconds) {
  if (timeSeconds <= 4 * 3600) return 'early_0_4h';
  if (timeSeconds <= 24 * 3600) return 'middle_4_24h';
  return 'late_24h_plus';
}

function stageMetrics(predicted, observed, times, indices) {
  const groups = {};
  for (const index of indices) {
    const name = stageName(times[index]);
    (groups[name] ??= []).push(index);
  }
  return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, residualMetrics(predicted, observed, group)]));
}

function fitSummary(simulation, observedPoints, split) {
  const predicted = simulation.store.radius.map((value) => value * 100);
  const observed = observedPoints.map(([, value]) => value * 100);
  const times = observedPoints.map(([time]) => time);
  return {
    train: residualMetrics(predicted, observed, split.train),
    validation: residualMetrics(predicted, observed, split.validation),
    tail: residualMetrics(predicted, observed, split.tail),
    trainByStage: stageMetrics(predicted, observed, times, split.train),
    validationByStage: stageMetrics(predicted, observed, times, split.validation),
    predictedRadiusCm: predicted,
    observedRadiusCm: observed,
    times,
  };
}

function csv(rows) {
  return rows.map((row) => row.map((value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\n');
}

function fmt(value, digits = 6) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : Number(value).toFixed(digits);
}

function lineSvg(series, xValues, options = {}) {
  const width = 1000;
  const height = 560;
  const margin = { left: 80, right: 30, top: 55, bottom: 65 };
  const allY = series.flatMap((item) => item.values).filter((value) => Number.isFinite(value));
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = options.yMin ?? Math.min(...allY);
  const yMax = options.yMax ?? Math.max(...allY);
  const sx = (x) => margin.left + (x - xMin) / Math.max(1e-12, xMax - xMin) * (width - margin.left - margin.right);
  const sy = (y) => height - margin.bottom - (y - yMin) / Math.max(1e-12, yMax - yMin) * (height - margin.top - margin.bottom);
  const grid = [];
  for (let i = 0; i <= 5; i++) {
    const y = yMin + (yMax - yMin) * i / 5;
    grid.push(`<line x1="${margin.left}" y1="${sy(y)}" x2="${width - margin.right}" y2="${sy(y)}" stroke="#e5e7eb"/><text x="${margin.left - 8}" y="${sy(y) + 4}" text-anchor="end" font-size="12">${y.toFixed(3)}</text>`);
  }
  const paths = series.map((item) => {
    const points = item.values.map((value, i) => Number.isFinite(value) ? `${sx(xValues[i]).toFixed(2)},${sy(value).toFixed(2)}` : null).filter(Boolean).join(' ');
    return `<polyline fill="none" stroke="${item.color}" stroke-width="${item.width ?? 2}" points="${points}"/>`;
  }).join('');
  const legend = series.map((item, i) => `<g transform="translate(${margin.left + i * 180},25)"><line x1="0" y1="-4" x2="24" y2="-4" stroke="${item.color}" stroke-width="3"/><text x="32" y="0" font-size="13">${item.label}</text></g>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="${width / 2}" y="20" text-anchor="middle" font-size="18" font-weight="600">${options.title ?? ''}</text>${legend}${grid.join('')}<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#111827"/><line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#111827"/>${paths}<text x="${width / 2}" y="${height - 18}" text-anchor="middle" font-size="13">${options.xLabel ?? 't / h'}</text><text x="18" y="${height / 2}" transform="rotate(-90 18 ${height / 2})" text-anchor="middle" font-size="13">${options.yLabel ?? ''}</text></svg>`;
}

async function writeRun(runDir, payload) {
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'run_manifest.json'), JSON.stringify(payload.manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'environment_and_shrinkage.json'), JSON.stringify(payload.environment, null, 2), 'utf8');
  if (payload.calibration) {
    await fs.writeFile(path.join(runDir, 'calibration_summary.json'), JSON.stringify(payload.calibration, null, 2), 'utf8');
    await fs.writeFile(path.join(runDir, 'p_grid.csv'), csv([['p', 'train_rmse_cm', 'train_max_abs_cm', 'validation_rmse_cm', 'validation_max_abs_cm', 'train_sse_cm2'], ...payload.calibration.pGrid.map((row) => [row.p, row.train.rmse, row.train.maxAbs, row.validation.rmse, row.validation.maxAbs, row.train.sse])]), 'utf8');
  }
  if (payload.observationRows) await fs.writeFile(path.join(runDir, 'radius_observations_and_predictions.csv'), csv(payload.observationRows), 'utf8');
  if (payload.comparison) await fs.writeFile(path.join(runDir, 'comparison_summary.json'), JSON.stringify(payload.comparison, null, 2), 'utf8');
  if (payload.states) await fs.writeFile(path.join(runDir, 'model_states.json'), JSON.stringify(payload.states, null, 2), 'utf8');
  if (payload.conclusion) await fs.writeFile(path.join(runDir, 'conclusion.md'), payload.conclusion, 'utf8');
  if (payload.charts) for (const [name, content] of Object.entries(payload.charts)) await fs.writeFile(path.join(runDir, name), content, 'utf8');
}

function splitDescription(split) {
  return {
    trainingIndex: split.train,
    validationIndex: split.validation,
    tailIndexUsedForLambda: split.tail,
    note: '验证块为连续观测点；最后tail点用于Rtail/lambda，因此不作为独立验证证据。',
  };
}

async function runCalibration(config, inputs, runDir) {
  const observations = inputs.pchip.points;
  const split = indexSplit(observations.length, config.calibration.validationBlocks, config.shrinkage.tailCount);
  const baseLaw = buildShrinkLaw(inputs.pchip, inputs.environment, config.shrinkage.pBase, config.shrinkage.tailCount);
  const simOptions = {
    n: config.calibration.calibrationN,
    dt: config.calibration.calibrationDtSeconds,
    tEnd: inputs.pchip.lastTime,
    outputInterval: config.calibration.observationIntervalSeconds,
    storeTimes: observationTimes(inputs.pchip),
    mesh: config.physics.mesh,
    ...config.numerics,
  };
  const evaluateP = async (p) => {
    const law = buildShrinkLaw(inputs.pchip, inputs.environment, p, config.shrinkage.tailCount);
    const simulation = simulateCoupledShrink(inputs.environment, law, simOptions);
    const fit = fitSummary(simulation, observations, split);
    return { p, law, simulation, ...fit };
  };
  const coarse = [];
  for (const p of config.shrinkage.pGrid) {
    const token = String(p).replace('.', 'p');
    const candidatePath = path.join(runDir, `calibration_p_${token}.json`);
    let cached = null;
    try {
      cached = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (cached && Number(cached.p) === p && cached.fit?.train && cached.fit?.validation) {
      coarse.push({ p, lambda: cached.law.lambda, rTail_cm: cached.law.rTail * 100, Ce: cached.law.Ce, train: cached.fit.train, validation: cached.fit.validation, trainByStage: cached.fit.trainByStage, validationByStage: cached.fit.validationByStage });
      continue;
    }
    const result = await evaluateP(p);
    coarse.push({ p, lambda: result.law.lambda, rTail_cm: result.law.rTail * 100, Ce: result.law.Ce, train: result.train, validation: result.validation, trainByStage: result.trainByStage, validationByStage: result.validationByStage });
    await fs.writeFile(candidatePath, JSON.stringify({ p, law: result.law, fit: { train: result.train, validation: result.validation, trainByStage: result.trainByStage, validationByStage: result.validationByStage }, balance: result.simulation.balance }, null, 2), 'utf8');
  }
  const bestCoarse = coarse.reduce((best, row) => row.train.sse < best.train.sse ? row : best);
  const fineGrid = [];
  for (let p = Math.max(0.025, bestCoarse.p - config.shrinkage.pFineHalfWidth); p <= bestCoarse.p + config.shrinkage.pFineHalfWidth + 1e-9; p += config.shrinkage.pFineStep) fineGrid.push(Number(p.toFixed(6)));
  const fine = [];
  for (const p of fineGrid) {
    const token = String(p).replace('.', 'p');
    const candidatePath = path.join(runDir, `calibration_p_fine_${token}.json`);
    let cached = null;
    try {
      cached = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (cached && Number(cached.p) === p && cached.fit?.train && cached.fit?.validation) {
      fine.push({ p, lambda: cached.law.lambda, rTail_cm: cached.law.rTail * 100, Ce: cached.law.Ce, train: cached.fit.train, validation: cached.fit.validation, trainByStage: cached.fit.trainByStage, validationByStage: cached.fit.validationByStage });
      continue;
    }
    const result = await evaluateP(p);
    fine.push({ p, lambda: result.law.lambda, rTail_cm: result.law.rTail * 100, Ce: result.law.Ce, train: result.train, validation: result.validation, trainByStage: result.trainByStage, validationByStage: result.validationByStage });
    await fs.writeFile(candidatePath, JSON.stringify({ p, law: result.law, fit: { train: result.train, validation: result.validation, trainByStage: result.trainByStage, validationByStage: result.validationByStage }, balance: result.simulation.balance }, null, 2), 'utf8');
  }
  const bestFine = fine.reduce((best, row) => row.train.sse < best.train.sse ? row : best);
  const selected = await evaluateP(bestFine.p);
  const p1 = await evaluateP(1);
  const payload = {
    split: splitDescription(split),
    pBase: { p: 1, law: p1.law, fit: { train: p1.train, validation: p1.validation, trainByStage: p1.trainByStage, validationByStage: p1.validationByStage } },
    coarse: { grid: config.shrinkage.pGrid, rows: coarse, bestP: bestCoarse.p },
    fine: { grid: fineGrid, rows: fine, bestP: bestFine.p },
    selected: { p: selected.p, law: selected.law, fit: { train: selected.train, validation: selected.validation, trainByStage: selected.trainByStage, validationByStage: selected.validationByStage }, balance: selected.simulation.balance, stageCrossings: selected.simulation.stageCrossings },
    observationRows: [['time_s', 'time_h', 'observed_R_cm', 'p1_R_cm', 'pCal_R_cm', 'p1_residual_cm', 'pCal_residual_cm', 'split', 'stage'], ...observations.map(([time, radius], i) => [time, time / 3600, radius * 100, p1.predictedRadiusCm[i], selected.predictedRadiusCm[i], p1.predictedRadiusCm[i] - radius * 100, selected.predictedRadiusCm[i] - radius * 100, split.train.includes(i) ? 'train' : split.validation.includes(i) ? 'validation' : 'tail_lambda', stageName(time)])],
    pGrid: [...coarse, ...fine],
  };
  await writeRun(runDir, {
    manifest: { kind: 'q4_shrink_coupled_calibration', createdAt: new Date().toISOString(), config, split: payload.split, outputs: ['environment_and_shrinkage.json', 'calibration_summary.json', 'p_grid.csv', 'radius_observations_and_predictions.csv'] },
    environment: { input: environmentInputPath, radiusInput: radiusInputPath, window: inputs.environment, p1: p1.law, selected: selected.law },
    calibration: payload,
    observationRows: payload.observationRows,
    conclusion: '# 含水率驱动收缩标定\n\n本目录保存原始1800 s半径测点的连续块训练/验证划分。最后5个半径点用于Rtail与lambda估计，因此不作为独立验证证据。候选p均重新运行双向耦合模型，未使用旧PCHIP轨迹的含水率做一次性拟合。',
  });
  return { ...payload, p1Result: p1, selectedResult: selected, split };
}

async function runComparison(config, inputs, calibration, runDir) {
  const pCal = calibration.selected.p;
  const n = config.calibration.verificationN;
  const dt = config.calibration.verificationDtSeconds;
  const tEnd = DEFAULT_T_END;
  const obsTimes = observationTimes(inputs.pchip);
  const dynamicOptions = { n, dt, tEnd, outputInterval: 1800, mesh: config.physics.mesh, ...config.numerics, stopAtThreshold: true };
  const p1Law = buildShrinkLaw(inputs.pchip, inputs.environment, 1, config.shrinkage.tailCount);
  const pCalLaw = buildShrinkLaw(inputs.pchip, inputs.environment, pCal, config.shrinkage.tailCount);
  const p1 = simulateCoupledShrink(inputs.environment, p1Law, dynamicOptions);
  const pCalResult = simulateCoupledShrink(inputs.environment, pCalLaw, dynamicOptions);
  const pchip = simulateQuestion4(inputs.environment, inputs.pchip, { physics: 'q4', kind: 'material', n, dt, tEnd, outputInterval: 1800, storeTimes: obsTimes, mesh: config.physics.mesh, residualTolerance: config.numerics.residualTolerance });
  const summary = {
    common: { environmentWindowSeconds: inputs.environment.windowSeconds, environmentWindowMethod: inputs.environment.windowMethod, Ce: inputs.environment.lastWindowMean.moisture, n, requestedDt: dt, mesh: config.physics.mesh, threshold: THRESHOLD_C },
    A_PCHIP: { finalTime_s: pchip.balance.finalTime, finalTime_h: pchip.balance.finalTime / 3600, thresholdEvent: pchip.balance.thresholdEvent, stageCrossings_s: pchip.stageCrossings, balance: pchip.balance, radiusMethod: 'observed_PCHIP' },
    B_p1: { finalTime_s: p1.balance.finalTime, finalTime_h: p1.balance.finalTime / 3600, thresholdEvent: p1.thresholdEvent, stageCrossings_s: p1.stageCrossings, balance: p1.balance, law: p1Law },
    C_pCal: { p: pCal, finalTime_s: pCalResult.balance.finalTime, finalTime_h: pCalResult.balance.finalTime / 3600, thresholdEvent: pCalResult.thresholdEvent, stageCrossings_s: pCalResult.stageCrossings, balance: pCalResult.balance, law: pCalLaw },
  };
  const pchipByTime = new Map(pchip.store.times.map((time, i) => [time, { radius: pchip.store.radius[i], cbar: pchip.store.meanMoisture[i], maxC: pchip.store.maximumMoisture[i] }]));
  const p1ByTime = new Map(p1.store.times.map((time, i) => [time, { radius: p1.store.radius[i], cbar: p1.store.cbar[i], maxC: p1.store.maximumMoisture[i] }]));
  const pCalByTime = new Map(pCalResult.store.times.map((time, i) => [time, { radius: pCalResult.store.radius[i], cbar: pCalResult.store.cbar[i], maxC: pCalResult.store.maximumMoisture[i] }]));
  const compareTimes = obsTimes.filter((time) => pchipByTime.has(time) || p1ByTime.has(time) || pCalByTime.has(time));
  const observationRows = [['time_s', 'time_h', 'observed_R_cm', 'PCHIP_R_cm', 'p1_R_cm', 'pCal_R_cm', 'PCHIP_cbar', 'p1_cbar', 'pCal_cbar', 'PCHIP_maxC', 'p1_maxC', 'pCal_maxC'], ...compareTimes.map((time) => [time, time / 3600, inputs.pchip.radius(time) * 100, pchipByTime.get(time)?.radius * 100, p1ByTime.get(time)?.radius * 100, pCalByTime.get(time)?.radius * 100, pchipByTime.get(time)?.cbar, p1ByTime.get(time)?.cbar, pCalByTime.get(time)?.cbar, pchipByTime.get(time)?.maxC, p1ByTime.get(time)?.maxC, pCalByTime.get(time)?.maxC])];
  const xHours = compareTimes.map((time) => time / 3600);
  const charts = {
    'radius_comparison.svg': lineSvg([
      { label: 'observed', color: '#111827', values: compareTimes.map((time) => inputs.pchip.radius(time) * 100), width: 2 },
      { label: 'PCHIP baseline', color: '#2563eb', values: compareTimes.map((time) => pchipByTime.get(time)?.radius * 100 ?? NaN) },
      { label: 'p=1', color: '#d97706', values: compareTimes.map((time) => p1ByTime.get(time)?.radius * 100 ?? NaN) },
      { label: `p=${pCal}`, color: '#059669', values: compareTimes.map((time) => pCalByTime.get(time)?.radius * 100 ?? NaN) },
    ], xHours, { title: '半径轨迹比较', xLabel: 't / h', yLabel: 'R / cm' }),
    'moisture_comparison.svg': lineSvg([
      { label: 'PCHIP cbar', color: '#2563eb', values: compareTimes.map((time) => pchipByTime.get(time)?.cbar ?? NaN) },
      { label: 'p=1 cbar', color: '#d97706', values: compareTimes.map((time) => p1ByTime.get(time)?.cbar ?? NaN) },
      { label: `p=${pCal} cbar`, color: '#059669', values: compareTimes.map((time) => pCalByTime.get(time)?.cbar ?? NaN) },
    ], xHours, { title: '平均干基含水率比较', xLabel: 't / h', yLabel: 'Cbar / kg/kg' }),
  };
  const conclusion = `# 含水率驱动收缩与PCHIP基准比较\n\n- A为实测半径PCHIP基准；B为p=1；C为训练集标定p=${pCal}。\n- 三组使用同一末30 min梯形环境均值、附录4物性、材料坐标、Robin边界和阈值。\n- PCHIP通过所有观测点，是观测约束基准，不等同于独立预测验证。\n- 新模型是否进入正文主模型，应以独立连续块验证误差、MR物理范围、耦合收敛和终点稳定性共同判断；不得用终点时长反调p。\n\n## 终点\n\n| 模型 | t*/h | 说明 |\n|---|---:|---|\n| PCHIP | ${fmt(summary.A_PCHIP.finalTime_h, 6)} | 实测半径约束基准 |\n| p=1 | ${fmt(summary.B_p1.finalTime_h, 6)} | 嵌套基准 |\n| p=${pCal} | ${fmt(summary.C_pCal.finalTime_h, 6)} | 训练集标定 |\n\n如果验证误差不能支撑新增本构，正文主结果保留PCHIP，新模型只作为扩展分析。`;
  await writeRun(runDir, {
    manifest: { kind: 'q4_shrink_coupled_comparison', createdAt: new Date().toISOString(), config, outputs: ['environment_and_shrinkage.json', 'comparison_summary.json', 'radius_observations_and_predictions.csv', 'radius_comparison.svg', 'moisture_comparison.svg', 'model_states.json', 'conclusion.md'] },
    environment: { input: environmentInputPath, radiusInput: radiusInputPath, window: inputs.environment, p1: p1Law, selected: pCalLaw },
    comparison: summary,
    observationRows,
    states: { PCHIP: pchip, p1, pCal: pCalResult },
    charts,
    conclusion,
  });
  return { summary, observationRows, charts, p1, pCal: pCalResult, pchip };
}

async function runNumericalVerification(config, inputs, calibration, comparison, runDir) {
  const pCal = calibration.selected.p;
  const law = buildShrinkLaw(inputs.pchip, inputs.environment, pCal, config.shrinkage.tailCount);
  const cases = [];
  const addStored = (name, n, requestedDt, stored, source) => {
    const thresholdEvent = stored.thresholdEvent ?? stored.balance?.thresholdEvent;
    const thresholdTime_s = stored.finalTime_s ?? thresholdEvent?.confirmedTime ?? null;
    cases.push({
      name,
      source,
      n,
      requestedDt,
      thresholdTime_s,
      thresholdTime_h: stored.finalTime_h ?? (thresholdTime_s == null ? null : thresholdTime_s / 3600),
      acceptedSteps: stored.balance?.acceptedSteps ?? null,
      rejectedSteps: stored.balance?.rejectedSteps ?? null,
      minAcceptedDt: stored.balance?.minAcceptedDt ?? null,
      maxAcceptedDt: stored.balance?.maxAcceptedDt ?? null,
      maxOuterIterations: stored.balance?.maxOuterIterations ?? null,
      maxInnerIterations: stored.balance?.maxInnerIterations ?? null,
      maxTemperatureResidual: stored.balance?.maxTemperatureResidual ?? null,
      maxMoistureResidual: stored.balance?.maxMoistureResidual ?? null,
      maxRadiusConsistency: stored.balance?.maxRadiusConsistency ?? null,
      moistureBalanceErrorRelative: stored.balance?.moistureBalanceErrorRelative ?? null,
      finalRadius_m: stored.balance?.finalRadius ?? null,
    });
  };
  addStored('N80_dt4_default', config.calibration.calibrationN, config.calibration.calibrationDtSeconds, calibration.selected, 'calibration_summary.selected');
  addStored('N160_dt1_default', config.calibration.verificationN, config.calibration.verificationDtSeconds, comparison.C_pCal, 'comparison_summary.C_pCal');
  const runCase = (name, n, dt, overrides = {}) => {
    const simulation = simulateCoupledShrink(inputs.environment, law, {
      n,
      dt,
      tEnd: DEFAULT_T_END,
      outputInterval: 21600,
      mesh: config.physics.mesh,
      ...config.numerics,
      stopAtThreshold: true,
      ...overrides,
    });
    const b = simulation.balance;
    cases.push({
      name,
      source: 'fresh_run',
      n,
      requestedDt: dt,
      thresholdTime_s: b.thresholdEvent?.confirmedTime ?? null,
      thresholdTime_h: b.thresholdEvent?.confirmedTime == null ? null : b.thresholdEvent.confirmedTime / 3600,
      acceptedSteps: b.acceptedSteps,
      rejectedSteps: b.rejectedSteps,
      minAcceptedDt: b.minAcceptedDt,
      maxAcceptedDt: b.maxAcceptedDt,
      maxOuterIterations: b.maxOuterIterations,
      maxInnerIterations: b.maxInnerIterations,
      maxTemperatureResidual: b.maxTemperatureResidual,
      maxMoistureResidual: b.maxMoistureResidual,
      maxRadiusConsistency: b.maxRadiusConsistency,
      moistureBalanceErrorRelative: b.moistureBalanceErrorRelative,
      finalRadius_m: b.finalRadius,
    });
  };
  runCase('N80_dt2_default', 80, 2);
  runCase('N160_dt4_default', 160, 4);
  runCase('N80_dt4_tight_tolerance', 80, 4, {
    temperatureUpdateTolerance: config.numerics.temperatureUpdateTolerance / 10,
    moistureUpdateTolerance: config.numerics.moistureUpdateTolerance / 10,
    radiusUpdateTolerance: config.numerics.radiusUpdateTolerance / 10,
    residualTolerance: config.numerics.residualTolerance / 10,
  });
  const payload = {
    selectedP: pCal,
    common: { environmentWindowSeconds: inputs.environment.windowSeconds, environmentWindowMethod: inputs.environment.windowMethod, Ce: inputs.environment.lastWindowMean.moisture, mesh: config.physics.mesh, threshold: THRESHOLD_C },
    cases,
    notes: [
      'N80_dt4_default and N160_dt1_default reuse completed calibration/comparison states; the other rows are fresh runs.',
      'The reported threshold time is the confirmed event time from the accepted simulation, not an independently claimed global time error bound.',
    ],
  };
  await fs.writeFile(path.join(runDir, 'numerical_verification.json'), JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'numerical_verification.csv'), csv([
    ['case', 'source', 'N', 'requested_dt_s', 'threshold_time_s', 'threshold_time_h', 'accepted_steps', 'rejected_steps', 'min_accepted_dt_s', 'max_accepted_dt_s', 'max_outer_iterations', 'max_inner_iterations', 'max_temperature_residual', 'max_moisture_residual', 'max_radius_consistency', 'moisture_balance_error_relative', 'final_radius_m'],
    ...cases.map((row) => [row.name, row.source, row.n, row.requestedDt, row.thresholdTime_s, row.thresholdTime_h, row.acceptedSteps, row.rejectedSteps, row.minAcceptedDt, row.maxAcceptedDt, row.maxOuterIterations, row.maxInnerIterations, row.maxTemperatureResidual, row.maxMoistureResidual, row.maxRadiusConsistency, row.moistureBalanceErrorRelative, row.finalRadius_m]),
  ]), 'utf8');
  await fs.writeFile(path.join(runDir, 'conclusion.md'), '# 数值稳定性核查\n\n本目录比较空间网格、请求时间步和非线性容差对标定 p 的达标时刻及残差的影响。N80_dt4 与 N160_dt1 复用已完成的标定/对照状态，其余配置为本次独立重跑。', 'utf8');
  return payload;
}

async function runSpaceRefinement(config, inputs, calibration, runDir) {
  const pCal = calibration.selected.p;
  const law = buildShrinkLaw(inputs.pchip, inputs.environment, pCal, config.shrinkage.tailCount);
  const simulation = simulateCoupledShrink(inputs.environment, law, {
    n: 320,
    dt: 1,
    tEnd: DEFAULT_T_END,
    outputInterval: 21600,
    mesh: config.physics.mesh,
    ...config.numerics,
    stopAtThreshold: true,
    progressPath: path.join(runDir, 'progress.jsonl'),
    progressLabel: 'space-N320-dt1',
    progressIntervalSeconds: 1800,
  });
  const b = simulation.balance;
  const payload = {
    p: pCal,
    n: 320,
    requestedDt: 1,
    thresholdTime_s: b.thresholdEvent?.confirmedTime ?? null,
    thresholdTime_h: b.thresholdEvent?.confirmedTime == null ? null : b.thresholdEvent.confirmedTime / 3600,
    acceptedSteps: b.acceptedSteps,
    rejectedSteps: b.rejectedSteps,
    minAcceptedDt: b.minAcceptedDt,
    maxAcceptedDt: b.maxAcceptedDt,
    maxOuterIterations: b.maxOuterIterations,
    maxInnerIterations: b.maxInnerIterations,
    maxTemperatureResidual: b.maxTemperatureResidual,
    maxMoistureResidual: b.maxMoistureResidual,
    maxRadiusConsistency: b.maxRadiusConsistency,
    moistureBalanceErrorRelative: b.moistureBalanceErrorRelative,
    finalRadius_m: b.finalRadius,
    law,
  };
  await fs.writeFile(path.join(runDir, 'space_refinement_n320_dt1.json'), JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'conclusion.md'), '# 空间加密核查\n\n本目录保存标定 p 在 N=320、请求时间步1 s下的独立重跑，用于与 N=160 结果比较。', 'utf8');
  return payload;
}

function parseArgs(argv) {
  const args = { mode: 'all', config: DEFAULT_CONFIG, outputRoot: DEFAULT_OUTPUT_ROOT };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, raw] = arg.slice(2).split('=', 2);
    const value = raw ?? 'true';
    if (key === 'mode') args.mode = value;
    else if (key === 'config') args.config = value;
    else if (key === 'output-root') args.outputRoot = value;
    else if (key === 'run-id') args.runId = value;
    else if (key === 'resume') args.resume = value === 'true' || value === '1';
    else if (key === 'calibration-run') args.calibrationRun = value;
    else if (key === 'comparison-run') args.comparisonRun = value;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!['tests', 'calibrate', 'compare', 'verify', 'space', 'all'].includes(args.mode)) throw new Error(`未知模式: ${args.mode}`);
  return args;
}

async function loadConfig(configPath) {
  return JSON.parse(await fs.readFile(path.resolve(projectRoot, configPath), 'utf8'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.config);
  const inputs = await loadInputs(config.environment.windowSeconds);
  const testLaw = buildShrinkLaw(inputs.pchip, inputs.environment, 1, config.shrinkage.tailCount);
  if (options.mode === 'tests') {
    const result = simulateCoupledShrink(inputs.environment, testLaw, { n: 16, dt: 0.5, tEnd: 5, outputInterval: 5, mesh: config.physics.mesh, ...config.numerics });
    console.log(JSON.stringify({ mode: 'tests', environment: { windowSeconds: inputs.environment.windowSeconds, method: inputs.environment.windowMethod, mean: inputs.environment.lastWindowMean }, law: { p: testLaw.p, lambda: testLaw.lambda, rTail: testLaw.rTail, Ce: testLaw.Ce }, result: { finalTime: result.balance.finalTime, radius: result.finalRadius, cbar: result.lastState.cbar, mr: result.lastState.mr, balance: result.balance } }, null, 2));
    return;
  }
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const runId = options.runId ?? `q4_shrink_${options.mode}_${stamp}`;
  const runDir = path.join(path.resolve(projectRoot, options.outputRoot), runId);
  try {
    const existing = await fs.readdir(runDir);
    if (existing.length > 0) throw new Error(`运行目录非空，拒绝覆盖: ${runDir}`);
  } catch (error) {
    if (error.code === 'ENOENT') await fs.mkdir(runDir, { recursive: true });
    else if (!options.resume) throw error;
  }
  if (options.mode === 'compare') {
    const calibrationDir = path.resolve(projectRoot, options.calibrationRun ?? 'code_q4_shrink/runs/q4_shrink_calibration_n80_dt4_w1800');
    const calibration = JSON.parse(await fs.readFile(path.join(calibrationDir, 'calibration_summary.json'), 'utf8'));
    const comparison = await runComparison(config, inputs, { selected: { p: calibration.selected.p } }, runDir);
    console.log(JSON.stringify({ runId, runDir, bestP: calibration.selected.p, comparison: comparison.summary }, null, 2));
    return;
  }
  if (options.mode === 'verify') {
    const calibrationDir = path.resolve(projectRoot, options.calibrationRun ?? 'code_q4_shrink/runs/q4_shrink_calibration_n80_dt4_w1800');
    const comparisonDir = path.resolve(projectRoot, options.comparisonRun ?? 'code_q4_shrink/runs/q4_shrink_compare_n160_dt1_w1800');
    const calibration = JSON.parse(await fs.readFile(path.join(calibrationDir, 'calibration_summary.json'), 'utf8'));
    const comparison = JSON.parse(await fs.readFile(path.join(comparisonDir, 'comparison_summary.json'), 'utf8'));
    const verification = await runNumericalVerification(config, inputs, calibration, comparison, runDir);
    console.log(JSON.stringify({ runId, runDir, bestP: verification.selectedP, cases: verification.cases }, null, 2));
    return;
  }
  if (options.mode === 'space') {
    const calibrationDir = path.resolve(projectRoot, options.calibrationRun ?? 'code_q4_shrink/runs/q4_shrink_calibration_n80_dt4_w1800');
    const calibration = JSON.parse(await fs.readFile(path.join(calibrationDir, 'calibration_summary.json'), 'utf8'));
    const refinement = await runSpaceRefinement(config, inputs, calibration, runDir);
    console.log(JSON.stringify({ runId, runDir, result: refinement }, null, 2));
    return;
  }
  if (options.mode === 'calibrate' || options.mode === 'all') {
    const calibration = await runCalibration(config, inputs, runDir);
    if (options.mode === 'calibrate') {
      console.log(JSON.stringify({ runId, runDir, bestP: calibration.selected.p, p1: calibration.pBase.p, p1Validation: calibration.pBase.fit.validation, selectedValidation: calibration.selected.fit.validation }, null, 2));
      return;
    }
    const comparison = await runComparison(config, inputs, calibration, runDir);
    console.log(JSON.stringify({ runId, runDir, bestP: calibration.selected.p, comparison: comparison.summary }, null, 2));
    return;
  }
  throw new Error('未知运行模式');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}

export { buildShrinkLaw, coupledShrinkStep, simulateCoupledShrink, makeEnvironment, runCalibration, runComparison, runNumericalVerification, runSpaceRefinement };
