import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import {
  coupledStep,
  gridFor as uniformGridFor,
  loadEnvironment,
} from '../code_q2/solve_q2.mjs';

const R0 = 0.02;
const H_T = 25;
const H_M = 8e-7;
const T0 = 28;
const C0 = 2.55;
const THRESHOLD_C = 0.15;
const DEFAULT_MAX_T = 72 * 3600;
const OUTPUT_RADII = Array.from({ length: 21 }, (_, i) => Number((i * 0.001).toFixed(3)));
const STAGE_THRESHOLDS = [0.6, 0.3, 0.2, 0.15];

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRootDefault = path.join(projectRoot, 'outputs', 'q3');

function gridFor(n, mesh = 'uniform') {
  if (mesh === 'uniform') return uniformGridFor(n);
  if (mesh !== 'surfaceRefined') throw new Error(`未知网格类型: ${mesh}`);
  if (!Number.isInteger(n) || n < 2) throw new Error(`径向区间数必须至少为 2: ${n}`);
  const dr = R0 / n;
  const normalized = Array.from({ length: n + 1 }, (_, i) => 1 - (1 - i / n) ** 2);
  const radii = normalized.map((value) => R0 * value);
  const weights = new Array(n + 1);
  const faces = new Array(n);
  const edgeWidths = new Array(n);
  for (let i = 0; i <= n; i++) {
    const rm = i === 0 ? 0 : 0.5 * (radii[i - 1] + radii[i]);
    const rp = i === n ? R0 : 0.5 * (radii[i] + radii[i + 1]);
    weights[i] = 0.5 * (rp * rp - rm * rm);
  }
  for (let i = 0; i < n; i++) {
    faces[i] = 0.5 * (radii[i] + radii[i + 1]);
    edgeWidths[i] = radii[i + 1] - radii[i];
  }
  return { n, dr, radii, weights, faces, edgeWidths, mesh };
}

function maxAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error('比较数组长度不一致');
  let result = 0;
  for (let i = 0; i < a.length; i++) result = Math.max(result, Math.abs(a[i] - b[i]));
  return result;
}

function sumWeighted(grid, state) {
  let total = 0;
  for (let i = 0; i <= grid.n; i++) total += grid.weights[i] * state[i];
  return total;
}

function weightedAverage(grid, state) {
  return (2 / (R0 * R0)) * sumWeighted(grid, state);
}

function heatCapacity(c) {
  return (650 + 128 * c) * (1450 + 2736 * c / (1 + c));
}

function interpolateState(radii, state, radius) {
  if (radius <= radii[0]) return state[0];
  if (radius >= radii[radii.length - 1]) return state[state.length - 1];
  let lo = 0;
  let hi = radii.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (radii[mid] <= radius) lo = mid;
    else hi = mid;
  }
  const w = (radius - radii[lo]) / (radii[hi] - radii[lo]);
  return state[lo] * (1 - w) + state[hi] * w;
}

function sampleState(grid, state) {
  return OUTPUT_RADII.map((radius) => interpolateState(grid.radii, state, radius));
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

function emptyStore() {
  return {
    times: [],
    temperature: [],
    moisture: [],
    meanTemperature: [],
    meanMoisture: [],
    surfaceTemperature: [],
    surfaceMoisture: [],
    maximumMoisture: [],
    maximumMoistureIndex: [],
  };
}

function storeRecord(store, time, grid, temperature, moisture) {
  const maximum = maxAndIndex(moisture);
  store.times.push(time);
  store.temperature.push(sampleState(grid, temperature));
  store.moisture.push(sampleState(grid, moisture));
  store.meanTemperature.push(weightedAverage(grid, temperature));
  store.meanMoisture.push(weightedAverage(grid, moisture));
  store.surfaceTemperature.push(temperature[grid.n]);
  store.surfaceMoisture.push(moisture[grid.n]);
  store.maximumMoisture.push(maximum.value);
  store.maximumMoistureIndex.push(maximum.index);
}

function exactTime(value) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-8 ? rounded : value;
}

function outputTimes(startTime, tEnd, interval) {
  const times = [];
  for (let t = startTime; t <= tEnd + 1e-8; t += interval) times.push(exactTime(Math.min(t, tEnd)));
  if (times[times.length - 1] < tEnd - 1e-8) times.push(tEnd);
  return times;
}

function validateState(temperature, moisture) {
  for (let i = 0; i < temperature.length; i++) {
    if (!Number.isFinite(temperature[i]) || !Number.isFinite(moisture[i]) || temperature[i] + 273.15 <= 0 || moisture[i] <= 0) {
      throw new Error(`状态非法: index=${i}, T=${temperature[i]}, C=${moisture[i]}`);
    }
  }
}

function makeConstantEnvironment(temperature, moisture) {
  return {
    extension: 'constant',
    lastTime: Infinity,
    temperaturePoints: [[0, temperature]],
    moisturePoints: [[0, moisture]],
    endpoint: { temperature, moisture },
    lastHourMean: { temperature, moisture },
    temperature: () => temperature,
    moisture: () => moisture,
  };
}

async function loadInitialStateFromQ2Xlsx(inputPath, targetTime, n, mesh = 'uniform') {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
  const temperatureValues = workbook.worksheets.getItemAt(0).getUsedRange(true).values;
  const moistureValues = workbook.worksheets.getItemAt(1).getUsedRange(true).values;
  if (temperatureValues.length < 2 || moistureValues.length < 2) throw new Error(`第二问结果表为空: ${inputPath}`);
  const sourceRadii = temperatureValues[0].slice(1).map((value) => Number(value) / 100);
  if (sourceRadii.some((value) => !Number.isFinite(value)) || sourceRadii.length < 2) throw new Error(`第二问结果表半径列无效: ${inputPath}`);
  const findStateRow = (values, name) => {
    const rows = values.slice(1).filter((row) => row[0] !== null && row[0] !== undefined);
    const row = rows.find((candidate) => Math.abs(Number(candidate[0]) - targetTime) < 1e-8);
    if (!row) throw new Error(`${name}未找到 t=${targetTime} s 的状态行: ${inputPath}`);
    return row.slice(1).map(Number);
  };
  const sourceTemperature = findStateRow(temperatureValues, '温度');
  const sourceMoisture = findStateRow(moistureValues, '水分浓度');
  if (sourceTemperature.length !== sourceRadii.length || sourceMoisture.length !== sourceRadii.length) throw new Error(`第二问结果表状态列与半径列长度不一致: ${inputPath}`);
  const grid = gridFor(n, mesh);
  const temperature = grid.radii.map((radius) => interpolateState(sourceRadii, sourceTemperature, radius));
  const moisture = grid.radii.map((radius) => interpolateState(sourceRadii, sourceMoisture, radius));
  return { time: targetTime, temperature, moisture, source: inputPath };
}

function stepOptions(options) {
  return {
    diffusionMode: { a: 1, b: 1 },
    relaxation: options.relaxation,
    maxIterations: options.maxIterations,
    temperatureUpdateTolerance: options.temperatureUpdateTolerance,
    moistureUpdateTolerance: options.moistureUpdateTolerance,
    residualTolerance: options.residualTolerance,
    heatExchangeCoefficient: H_T,
    moistureExchangeCoefficient: H_M,
  };
}

function refineThreshold(environment, leftTime, leftTemperature, leftMoisture, rightTime, rightTemperature, rightMoisture, options) {
  let lo = leftTime;
  let loTemperature = leftTemperature;
  let loMoisture = leftMoisture;
  let hi = rightTime;
  let hiTemperature = rightTemperature;
  let hiMoisture = rightMoisture;
  const crossing = THRESHOLD_C;
  for (let iteration = 0; iteration < 34 && hi - lo > 1e-3; iteration++) {
    const mid = 0.5 * (lo + hi);
    const env = { time: mid, temperature: environment.temperature(mid), moisture: environment.moisture(mid) };
    const step = coupledStep(options.grid, leftTemperature, leftMoisture, mid - leftTime, env, stepOptions(options));
    const maximum = Math.max(...step.moisture);
    if (maximum < crossing) {
      hi = mid;
      hiTemperature = step.temperature;
      hiMoisture = step.moisture;
    } else {
      lo = mid;
      loTemperature = step.temperature;
      loMoisture = step.moisture;
    }
  }
  return {
    time: hi,
    temperature: hiTemperature,
    moisture: hiMoisture,
    bracket: [lo, hi],
    leftState: { temperature: loTemperature, moisture: loMoisture },
    maximum: Math.max(...hiMoisture),
  };
}

function simulateQuestion3(environment, options = {}) {
  const n = options.n ?? 160;
  const requestedDt = options.dt ?? 1;
  const mesh = options.mesh ?? 'uniform';
  const startTime = options.startTime ?? 0;
  const tEnd = options.tEnd ?? DEFAULT_MAX_T;
  const outputInterval = options.outputInterval ?? 60;
  if (!(tEnd > startTime)) throw new Error(`终止时刻必须大于初始时刻: startTime=${startTime}, tEnd=${tEnd}`);
  const requestedTimes = options.storeTimes ?? outputTimes(startTime, tEnd, outputInterval);
  const grid = gridFor(n, mesh);
  let temperature = options.initialTemperature?.slice() ?? new Array(n + 1).fill(T0);
  let moisture = options.initialMoisture?.slice() ?? new Array(n + 1).fill(C0);
  validateState(temperature, moisture);
  const store = emptyStore();
  const balance = {
    initialTime: startTime,
    initialMoistureIntegral: sumWeighted(grid, moisture),
    cumulativeBoundaryMoistureOutflow: 0,
    initialThermalStorage: 0,
    cumulativeBoundaryHeatOutflow: 0,
    cumulativeThermalStorageChange: 0,
    maxPicardIterations: 0,
    maxPicardTemperatureUpdate: 0,
    maxPicardMoistureUpdate: 0,
    maxPicardTemperatureResidual: 0,
    maxPicardMoistureResidual: 0,
    acceptedSteps: 0,
    rejectedSteps: 0,
    minTemperature: Math.min(...temperature),
    maxTemperature: Math.max(...temperature),
    minMoisture: Math.min(...moisture),
    maxMoisture: Math.max(...moisture),
  };
  balance.initialThermalStorage = sumWeighted(grid, moisture.map((c, i) => heatCapacity(c) * temperature[i]));
  let t = startTime;
  let dt = requestedDt;
  let outputIndex = 0;
  let previousMaximum = Math.max(...moisture);
  const stageCrossings = {};
  let thresholdEvent = null;
  let endpointState = null;
  const accept = (oldTemperature, oldMoisture, newTemperature, newMoisture, dtUsed, env, step) => {
    const boundaryMoistureOutflow = dtUsed * R0 * H_M * (newMoisture[grid.n] - env.moisture);
    const boundaryHeatOutflow = dtUsed * R0 * H_T * (newTemperature[grid.n] - env.temperature);
    const thermalStorageChange = sumWeighted(grid, newTemperature.map((value, i) => heatCapacity(newMoisture[i]) * value - heatCapacity(oldMoisture[i]) * oldTemperature[i]));
    balance.cumulativeBoundaryMoistureOutflow += boundaryMoistureOutflow;
    balance.cumulativeBoundaryHeatOutflow += boundaryHeatOutflow;
    balance.cumulativeThermalStorageChange += thermalStorageChange;
    balance.maxPicardIterations = Math.max(balance.maxPicardIterations, step.iterations);
    balance.maxPicardTemperatureUpdate = Math.max(balance.maxPicardTemperatureUpdate, step.temperatureUpdate);
    balance.maxPicardMoistureUpdate = Math.max(balance.maxPicardMoistureUpdate, step.moistureUpdate);
    balance.maxPicardTemperatureResidual = Math.max(balance.maxPicardTemperatureResidual, step.temperatureResidual.scaled);
    balance.maxPicardMoistureResidual = Math.max(balance.maxPicardMoistureResidual, step.moistureResidual.scaled);
    balance.acceptedSteps++;
    balance.minTemperature = Math.min(balance.minTemperature, ...newTemperature);
    balance.maxTemperature = Math.max(balance.maxTemperature, ...newTemperature);
    balance.minMoisture = Math.min(balance.minMoisture, ...newMoisture);
    balance.maxMoisture = Math.max(balance.maxMoisture, ...newMoisture);
  };
  const recordDue = (time, currentTemperature, currentMoisture) => {
    while (outputIndex < requestedTimes.length && requestedTimes[outputIndex] <= time + 1e-8) {
      if (Math.abs(requestedTimes[outputIndex] - time) > 1e-8) throw new Error(`输出时间未准确落点: ${requestedTimes[outputIndex]} vs ${time}`);
      storeRecord(store, exactTime(time), grid, currentTemperature, currentMoisture);
      outputIndex++;
    }
  };
  recordDue(startTime, temperature, moisture);

  while (t < tEnd - 1e-10) {
    const target = requestedTimes[outputIndex] ?? tEnd;
    const dtStep = Math.min(dt, target - t, tEnd - t);
    if (!(dtStep > 0)) {
      if (Math.abs(target - t) < 1e-8) {
        outputIndex++;
        continue;
      }
      throw new Error(`时间推进目标异常: t=${t}, target=${target}, dt=${dt}`);
    }
    const oldTime = t;
    const oldTemperature = temperature;
    const oldMoisture = moisture;
    const oldMaximum = previousMaximum;
    try {
      const nextTime = oldTime + dtStep;
      const env = { time: nextTime, temperature: environment.temperature(nextTime), moisture: environment.moisture(nextTime) };
      const step = coupledStep(grid, oldTemperature, oldMoisture, dtStep, env, stepOptions(options));
      validateState(step.temperature, step.moisture);
      const newMaximum = Math.max(...step.moisture);
      let crossedThreshold = oldMaximum > THRESHOLD_C && newMaximum <= THRESHOLD_C;
      if (crossedThreshold) {
        const refined = refineThreshold(environment, oldTime, oldTemperature, oldMoisture, nextTime, step.temperature, step.moisture, { ...options, grid });
        const refinedDt = refined.time - oldTime;
        const refinedEnv = { time: refined.time, temperature: environment.temperature(refined.time), moisture: environment.moisture(refined.time) };
        const refinedStep = coupledStep(grid, oldTemperature, oldMoisture, refinedDt, refinedEnv, stepOptions(options));
        accept(oldTemperature, oldMoisture, refinedStep.temperature, refinedStep.moisture, refinedDt, refinedEnv, refinedStep);
        t = refined.time;
        temperature = refinedStep.temperature;
        moisture = refinedStep.moisture;
        endpointState = { time: t, temperature: temperature.slice(), moisture: moisture.slice() };
        for (const threshold of STAGE_THRESHOLDS) {
          if (oldMaximum > threshold && newMaximum <= threshold && stageCrossings[threshold] === undefined) {
            const fraction = (threshold - oldMaximum) / (newMaximum - oldMaximum);
            stageCrossings[threshold] = oldTime + Math.max(0, Math.min(1, fraction)) * dtStep;
          }
        }
        stageCrossings[THRESHOLD_C] = refined.time;
        thresholdEvent = {
          bracket: refined.bracket,
          linearEstimate: oldTime + ((THRESHOLD_C - oldMaximum) / (newMaximum - oldMaximum)) * dtStep,
          confirmedTime: refined.time,
          confirmedMaximum: Math.max(...refinedStep.moisture),
          confirmedIndex: maxAndIndex(refinedStep.moisture).index,
          criterion: 'max over all internal nodes < 0.15 kg/kg',
        };
        recordDue(t, temperature, moisture);
        break;
      }
      accept(oldTemperature, oldMoisture, step.temperature, step.moisture, dtStep, env, step);
      t = nextTime;
      temperature = step.temperature;
      moisture = step.moisture;
      for (const threshold of STAGE_THRESHOLDS) {
        if (oldMaximum > threshold && newMaximum <= threshold && stageCrossings[threshold] === undefined) {
          const fraction = (threshold - oldMaximum) / (newMaximum - oldMaximum);
          stageCrossings[threshold] = oldTime + Math.max(0, Math.min(1, fraction)) * dtStep;
        }
      }
      previousMaximum = newMaximum;
      recordDue(t, temperature, moisture);
    } catch (error) {
      if (dt <= requestedDt / 128) throw error;
      dt *= 0.5;
      balance.rejectedSteps++;
    }
  }
  if (!endpointState && Math.abs(t - tEnd) < 1e-8) endpointState = { time: t, temperature: temperature.slice(), moisture: moisture.slice() };
  if (endpointState && (store.times.length === 0 || Math.abs(store.times[store.times.length - 1] - endpointState.time) > 1e-8)) {
    storeRecord(store, endpointState.time, grid, endpointState.temperature, endpointState.moisture);
  }
  balance.finalMoistureIntegral = sumWeighted(grid, moisture);
  balance.integralMoistureLoss = balance.initialMoistureIntegral - balance.finalMoistureIntegral;
  balance.moistureBalanceError = balance.integralMoistureLoss - balance.cumulativeBoundaryMoistureOutflow;
  balance.thermalStorageBalanceError = balance.cumulativeThermalStorageChange + balance.cumulativeBoundaryHeatOutflow;
  balance.finalTime = t;
  balance.thresholdEvent = thresholdEvent;
  const slopeWindows = {};
  for (const window of [60, 120, 300, 600]) {
    const target = t - window;
    let index = 0;
    for (let i = 0; i < store.times.length; i++) if (store.times[i] <= target + 1e-8) index = i;
    const last = store.times.length - 1;
    if (last > index && store.times[last] > store.times[index]) {
      slopeWindows[window] = (store.maximumMoisture[last] - store.maximumMoisture[index]) / (store.times[last] - store.times[index]);
    }
  }
  return {
    grid,
    store,
    balance,
    requestedDt,
    tEnd,
    outputInterval,
    startTime,
    initialSource: options.initialSource ?? null,
    finalTemperature: temperature,
    finalMoisture: moisture,
    stageCrossings,
    slopeWindows,
    endpointState,
  };
}

function runBasicTests() {
  const environment = makeConstantEnvironment(T0, C0);
  const result = simulateQuestion3(environment, { n: 16, dt: 1, tEnd: 20, outputInterval: 20 });
  const initialTemperature = new Array(result.grid.n + 1).fill(T0);
  const initialMoisture = new Array(result.grid.n + 1).fill(C0);
  return {
    equilibriumTemperatureChange: maxAbsDiff(result.finalTemperature, initialTemperature),
    equilibriumMoistureChange: maxAbsDiff(result.finalMoisture, initialMoisture),
    acceptedSteps: result.balance.acceptedSteps,
  };
}

function table5(result) {
  const reportTimes = [0, 6 * 3600, 12 * 3600, 18 * 3600, 24 * 3600, 30 * 3600, 36 * 3600, 42 * 3600, 48 * 3600, 54 * 3600, 60 * 3600, 66 * 3600, 72 * 3600];
  const radiiIndex = [0, 5, 10, 15, 20];
  const lines = [
    '# A题第三问表5',
    '',
    '单位：时间为 h，温度为 ℃，水分浓度为 kg/kg。空间列为到中心的物理距离/cm。',
    '',
    '## 温度',
    '',
    `| 时间/h | ${radiiIndex.map((i) => OUTPUT_RADII[i] * 100).join(' | ')} |`,
    '|---:|' + radiiIndex.map(() => '---:').join('|') + '|',
  ];
  const addTable = (records, digits) => {
    for (const time of reportTimes) {
      let i = result.store.times.findIndex((value) => Math.abs(value - time) < 1e-8);
      if (i < 0) continue;
      lines.push(`| ${(time / 3600).toFixed(4)} | ${radiiIndex.map((j) => records[i][j].toFixed(digits)).join(' | ')} |`);
    }
  };
  addTable(result.store.temperature, 4);
  lines.push('', '## 水分浓度', '', `| 时间/h | ${radiiIndex.map((i) => OUTPUT_RADII[i] * 100).join(' | ')} |`, '|---:|' + radiiIndex.map(() => '---:').join('|') + '|');
  addTable(result.store.moisture, 4);
  if (result.endpointState) {
    lines.push('', `结束时刻：${(result.endpointState.time / 3600).toFixed(6)} h；全域最大含水率：${Math.max(...result.endpointState.moisture).toFixed(8)} kg/kg。`);
  }
  return lines.join('\n');
}

function csv(rows) {
  return rows.map((row) => row.map((value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[,"\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\n') + '\n';
}

function buildWorkbook(result, title) {
  const workbook = Workbook.create();
  const summary = workbook.worksheets.add('终点摘要');
  const temperatureSheet = workbook.worksheets.add('温度');
  const moistureSheet = workbook.worksheets.add('水分浓度');
  const summaryRows = [
    ['A题第三问：全域达标时刻', '', '', ''],
    ['指标', '数值', '单位', '说明'],
    ['确认结束时刻', result.endpointState ? result.endpointState.time / 3600 : null, 'h', result.endpointState ? '确认 max(C)<0.15' : '72 h预算内未达标'],
    ['终止时全域最大含水率', result.endpointState ? Math.max(...result.endpointState.moisture) : Math.max(...result.finalMoisture), 'kg/kg', '未舍入值'],
    ['终点最大值位置', result.balance.thresholdEvent ? result.grid.radii[result.balance.thresholdEvent.confirmedIndex] * 100 : null, 'cm', '内部网格节点'],
    ['环境延拓', title.includes('lastHourMean') ? 'lastHourMean' : 'lastValue', '', '由运行配置给出'],
    ['阈值', THRESHOLD_C, 'kg/kg', '严格全域阈值'],
    ['末段下降斜率（60 s窗口）', result.slopeWindows[60] ?? null, 'kg/kg/s', 'Cmax差分估计'],
    ['水分收支差', result.balance.moistureBalanceError, 'm²·kg/kg', '固定半径归一化积分'],
    ['计算初始时刻', result.startTime / 3600, 'h', result.initialSource ? '由第二问结果场插值后继续' : '题设初始状态'],
    ['阶段', '时间/h', '单位', 'Cmax首次穿越估计'],
    ...STAGE_THRESHOLDS.map((threshold) => [String(threshold), result.stageCrossings[threshold] === undefined ? null : result.stageCrossings[threshold] / 3600, 'h', threshold === THRESHOLD_C ? '二分回算后确认' : '步内线性定位']),
  ];
  summary.showGridLines = false;
  summary.getRangeByIndexes(0, 0, summaryRows.length, 4).values = summaryRows;
  summary.getRange('A1:D1').merge();
  summary.getRange('A1:D1').format = { font: { name: 'Arial', size: 14, bold: true, color: '#1F1F1F' }, verticalAlignment: 'center' };
  summary.getRange('A2:D2').format = { fill: '#1F4E78', font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center', verticalAlignment: 'center' };
  summary.getRange('A11:D11').format = { fill: '#D9EAF7', font: { name: 'Arial', size: 10, bold: true, color: '#1F1F1F' }, horizontalAlignment: 'center' };
  summary.getRange('A1:D15').format.font = { name: 'Arial', size: 10, color: '#222222' };
  summary.getRange('A1:D1').format.font = { name: 'Arial', size: 14, bold: true, color: '#1F1F1F' };
  summary.getRange('B3:B15').format.numberFormat = '0.000000';
  summary.getRange('A1:D15').format.verticalAlignment = 'center';
  summary.getRange('A1:D15').format.borders = { insideHorizontal: { style: 'thin', color: '#D9E2F3' }, bottom: { style: 'thin', color: '#A6A6A6' } };
  summary.getRange('A1:A15').format.columnWidth = 30;
  summary.getRange('B1:B15').format.columnWidth = 16;
  summary.getRange('C1:C15').format.columnWidth = 15;
  summary.getRange('D1:D15').format.columnWidth = 30;

  const header = ['时间/s 到药材中心的距离/cm', ...OUTPUT_RADII.map((radius) => Number((radius * 100).toFixed(1)))];
  const rowsTemperature = [header, ...result.store.times.map((time, i) => [time, ...result.store.temperature[i]])];
  const rowsMoisture = [header, ...result.store.times.map((time, i) => [time, ...result.store.moisture[i]])];
  const writeDataSheet = (sheet, rows, unit) => {
    sheet.showGridLines = false;
    sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).values = rows;
    sheet.getRangeByIndexes(0, 0, 1, rows[0].length).format = { fill: '#1F4E78', font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true };
    sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).format.font = { name: 'Arial', size: 10, color: '#222222' };
    sheet.getRangeByIndexes(0, 0, 1, rows[0].length).format.font = { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' };
    sheet.getRangeByIndexes(1, 0, rows.length - 1, 1).format.numberFormat = '0.000';
    sheet.getRangeByIndexes(1, 1, rows.length - 1, rows[0].length - 1).format.numberFormat = '0.0000';
    sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).format.verticalAlignment = 'center';
    sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).format.borders = { insideHorizontal: { style: 'thin', color: '#D9E2F3' }, bottom: { style: 'thin', color: '#A6A6A6' } };
    sheet.getRangeByIndexes(0, 0, rows.length, 1).format.columnWidth = 25;
    sheet.getRangeByIndexes(0, 1, 1, rows[0].length - 1).format.columnWidth = 10;
    sheet.freezePanes.freezeRows(1);
    sheet.freezePanes.freezeColumns(1);
    sheet.getRange('W1').values = [[`${title}；单位：${unit}`]];
    sheet.getRange('W1').format.font = { name: 'Arial', size: 10, italic: true, color: '#666666' };
    sheet.getRange('W1').format.columnWidth = 34;
  };
  writeDataSheet(temperatureSheet, rowsTemperature, '℃');
  writeDataSheet(moistureSheet, rowsMoisture, 'kg/kg');
  workbook.recalculate();
  return workbook;
}

function parseArgs(argv) {
  const args = { mode: 'full', extension: 'lastValue' };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, rawValue] = arg.slice(2).split('=', 2);
    const value = rawValue ?? 'true';
    if (key === 'mode') args.mode = value;
    else if (key === 'n') args.n = Number(value);
    else if (key === 'dt') args.dt = Number(value);
    else if (key === 't-end') args.tEnd = Number(value);
    else if (key === 'start-time') args.startTime = Number(value);
    else if (key === 'mesh') args.mesh = value;
    else if (key === 'output-interval') args.outputInterval = Number(value);
    else if (key === 'extension') args.extension = value;
    else if (key === 'run-id') args.runId = value;
    else if (key === 'convergence-file') args.convergenceFile = value;
    else if (key === 'convergence-files') args.convergenceFiles = value;
    else if (key === 'output-root') args.outputRoot = value;
    else if (key === 'initial-xlsx') args.initialXlsx = value;
    else if (key === 'no-xlsx') args.noXlsx = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!['full', 'rough', 'tests'].includes(args.mode)) throw new Error(`未知运行模式: ${args.mode}`);
  if (!['lastValue', 'lastHourMean'].includes(args.extension)) throw new Error(`未知环境延拓: ${args.extension}`);
  if (args.mesh !== undefined && !['uniform', 'surfaceRefined'].includes(args.mesh)) throw new Error(`未知网格类型: ${args.mesh}`);
  if (args.mode === 'rough') {
    args.n = args.n ?? 40;
    args.dt = args.dt ?? 10;
  } else {
    args.n = args.n ?? 160;
    args.dt = args.dt ?? 1;
  }
  args.tEnd = args.tEnd ?? DEFAULT_MAX_T;
  args.outputInterval = args.outputInterval ?? 60;
  return args;
}

async function createRunDirectory(options) {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const runId = options.runId ?? `q3_${options.mode}_${options.extension}_${stamp}`;
  const outputRoot = options.outputRoot ? path.resolve(projectRoot, options.outputRoot) : outputRootDefault;
  const runDir = path.join(outputRoot, runId);
  try {
    const existing = await fs.readdir(runDir);
    if (existing.length > 0) throw new Error(`运行目录非空，拒绝覆盖: ${runDir}`);
  } catch (error) {
    if (error.code === 'ENOENT') await fs.mkdir(runDir, { recursive: true });
    else throw error;
  }
  return { runId, runDir, outputRoot };
}

async function writeArtifacts(runDir, environment, result, tests, options, elapsedMs) {
  const output = {
    run: { mode: options.mode, extension: options.extension, elapsedMs, projectRoot, outputRoot: path.dirname(runDir) },
    parameters: { R0, H_T, H_M, T0, C0, threshold: THRESHOLD_C, n: result.grid.n, dt: result.requestedDt, dr: result.grid.dr, mesh: result.grid.mesh, outputInterval: result.outputInterval, startTime: result.startTime },
    initialState: { source: result.initialSource, time: result.startTime },
    environment: { temperature: environment.temperaturePoints, moisture: environment.moisturePoints, extension: environment.extension, endpoint: environment.endpoint, lastHourMean: environment.lastHourMean },
    times: result.store.times,
    radii_m: OUTPUT_RADII,
    temperature_C: result.store.temperature,
    moisture_kg_per_kg: result.store.moisture,
    volume_mean_temperature_C: result.store.meanTemperature,
    volume_mean_moisture_kg_per_kg: result.store.meanMoisture,
    surface_temperature_C: result.store.surfaceTemperature,
    surface_moisture_kg_per_kg: result.store.surfaceMoisture,
    maximum_moisture_kg_per_kg: result.store.maximumMoisture,
    maximum_moisture_index: result.store.maximumMoistureIndex,
    stageCrossings_s: result.stageCrossings,
    slopeWindows_kg_per_kg_per_s: result.slopeWindows,
    balance: { ...result.balance, extension: options.extension },
    convergence: options.convergence ?? null,
    tests,
  };
  await fs.writeFile(path.join(runDir, 'result3_internal.json'), JSON.stringify(output, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'tables_5.md'), table5(result), 'utf8');
  await fs.writeFile(path.join(runDir, 'endpoint_localization.csv'), csv([
    ['quantity', 'value', 'unit'],
    ['confirmed_time', result.balance.thresholdEvent?.confirmedTime ?? '', 's'],
    ['linear_estimate', result.balance.thresholdEvent?.linearEstimate ?? '', 's'],
    ['bracket_left', result.balance.thresholdEvent?.bracket?.[0] ?? '', 's'],
    ['bracket_right', result.balance.thresholdEvent?.bracket?.[1] ?? '', 's'],
    ['confirmed_maximum', result.balance.thresholdEvent?.confirmedMaximum ?? '', 'kg/kg'],
    ['confirmed_index', result.balance.thresholdEvent?.confirmedIndex ?? '', 'node'],
  ]), 'utf8');
  await fs.writeFile(path.join(runDir, 'stage_crossings.csv'), csv([
    ['threshold_kg_per_kg', 'time_s', 'time_h'],
    ...STAGE_THRESHOLDS.map((threshold) => [threshold, result.stageCrossings[threshold] ?? '', result.stageCrossings[threshold] === undefined ? '' : result.stageCrossings[threshold] / 3600]),
  ]), 'utf8');
  if (options.convergence) await fs.writeFile(path.join(runDir, 'convergence_q3.json'), JSON.stringify(options.convergence, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'validation_q3.md'), [
    '# A题第三问验证记录', '',
    `- 模式：${options.mode}；环境延拓：${options.extension}；网格=${result.grid.mesh}；N=${result.grid.n}；请求步长=${result.requestedDt} s；输出间隔=${result.outputInterval} s；计算起始=${result.startTime} s。`,
    `- 初始状态：${result.initialSource ? `读取 ${result.initialSource} 的 t=${result.startTime} s 行并插值到当前网格` : '题设 t=0 初始状态'}。`,
    `- 实际耗时：${(elapsedMs / 1000).toFixed(3)} s；接受步=${result.balance.acceptedSteps}；回退步=${result.balance.rejectedSteps}；实际终点=${result.balance.finalTime} s。`,
    `- 终点定义：max(C) < ${THRESHOLD_C} kg/kg，检查全部 ${result.grid.n + 1} 个内部节点。`,
    `- 终点事件：${result.balance.thresholdEvent ? JSON.stringify(result.balance.thresholdEvent) : '预算内未发生'}。`,
    `- 阶段穿越：${JSON.stringify(result.stageCrossings)}。`,
    `- 末段斜率窗口：${JSON.stringify(result.slopeWindows)}。`,
    `- 水分积分损失=${result.balance.integralMoistureLoss}; 累计表面交换=${result.balance.cumulativeBoundaryMoistureOutflow}; 收支差=${result.balance.moistureBalanceError}。`,
    `- Picard最大轮数=${result.balance.maxPicardIterations}; T/C最大尺度残差=${result.balance.maxPicardTemperatureResidual}/${result.balance.maxPicardMoistureResidual}。`,
    '- 四舍五入仅用于表格展示；事件判断使用未舍入场值。',
    '- 若预算内未达标，不能把72 h终点写作“已烘干”；需延长预算或报告未达标。',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(runDir, 'run_manifest.json'), JSON.stringify({
    runId: path.basename(runDir), createdAt: new Date().toISOString(), options,
    outputs: ['result3_internal.json', 'tables_5.md', 'endpoint_localization.csv', 'stage_crossings.csv', ...(options.convergence ? ['convergence_q3.json'] : []), 'validation_q3.md', ...(options.noXlsx ? [] : ['result3.xlsx'])],
  }, null, 2), 'utf8');
  if (!options.noXlsx) {
    const workbook = buildWorkbook(result, `A题第三问 ${options.extension}`);
    const preview = await workbook.render({ sheetName: '终点摘要', range: 'A1:D14', scale: 2, format: 'png' });
    await fs.writeFile(path.join(runDir, 'preview_summary.png'), new Uint8Array(await preview.arrayBuffer()));
    const xlsx = await SpreadsheetFile.exportXlsx(workbook);
    await xlsx.save(path.join(runDir, 'result3.xlsx'));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { runId, runDir, outputRoot } = await createRunDirectory(options);
  const started = Date.now();
  const environment = await loadEnvironment(options.extension);
  if (options.initialXlsx) {
    const initialPath = path.resolve(projectRoot, options.initialXlsx);
    const initial = await loadInitialStateFromQ2Xlsx(initialPath, options.startTime ?? 3 * 3600, options.n, options.mesh);
    options.startTime = initial.time;
    options.initialTemperature = initial.temperature;
    options.initialMoisture = initial.moisture;
    options.initialSource = initial.source;
  } else if (options.startTime !== undefined) {
    throw new Error('指定 --start-time 时必须同时指定 --initial-xlsx');
  }
  if (options.convergenceFile) options.convergence = JSON.parse(await fs.readFile(path.resolve(projectRoot, options.convergenceFile), 'utf8'));
  if (options.convergenceFiles) {
    const files = options.convergenceFiles.split(',').map((value) => path.resolve(projectRoot, value));
    options.convergence = { runs: [] };
    for (const file of files) {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      options.convergence.runs.push({ file, n: data.parameters.n, dt_s: data.parameters.dt, finalTime_s: data.balance.finalTime, confirmedTime_s: data.balance.thresholdEvent?.confirmedTime ?? null, confirmedMaximum: data.balance.thresholdEvent?.confirmedMaximum ?? null });
    }
  }
  const tests = { basic: runBasicTests() };
  if (options.mode === 'tests') {
    const result = simulateQuestion3(makeConstantEnvironment(T0, C0), { n: 16, dt: 1, tEnd: 20, outputInterval: 20 });
    await writeArtifacts(runDir, environment, result, tests, options, Date.now() - started);
    console.log(JSON.stringify({ runId, runDir, outputRoot, tests }, null, 2));
    return;
  }
  const result = simulateQuestion3(environment, options);
  await writeArtifacts(runDir, environment, result, tests, options, Date.now() - started);
  console.log(JSON.stringify({ runId, runDir, outputRoot, finalTime: result.balance.finalTime, thresholdEvent: result.balance.thresholdEvent, tests }, null, 2));
}

export {
  R0,
  H_T,
  H_M,
  T0,
  C0,
  THRESHOLD_C,
  OUTPUT_RADII,
  simulateQuestion3,
  makeConstantEnvironment,
  loadEnvironment,
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
