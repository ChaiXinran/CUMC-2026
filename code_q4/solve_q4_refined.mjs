import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import { makeConstantEnvironment } from '../code_q3/solve_q3.mjs';

const R0 = 0.02;
const H_T = 25;
const H_M = 8e-7;
const T0 = 28;
const C0 = 2.55;
const THRESHOLD_C = 0.15;
const DEFAULT_MAX_T = 600000;
const OUTPUT_RADII = Array.from({ length: 20 }, (_, i) => Number((i * 0.001).toFixed(3)));
const TABLE6_RADII = [0, 0.005, 0.010, 0.015];
const STAGE_THRESHOLDS = [0.6, 0.3, 0.2, 0.15];

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environmentInputPath = path.join(projectRoot, 'CUMCM2026Problems', 'A题', '附件', '附件1.xlsx');
const radiusInputPath = path.join(projectRoot, 'CUMCM2026Problems', 'A题', '附件', '附件2.xlsx');
const outputRootDefault = path.join(projectRoot, 'outputs', 'q4_refined');

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

function gridForCoordinate(n, length, mesh = 'surfaceRefined') {
  if (!Number.isInteger(n) || n < 2) throw new Error(`网格区间数必须至少为2: ${n}`);
  if (!['uniform', 'surfaceRefined'].includes(mesh)) throw new Error(`未知网格类型: ${mesh}`);
  const normalized = Array.from({ length: n + 1 }, (_, i) => mesh === 'surfaceRefined' ? 1 - (1 - i / n) ** 2 : i / n);
  const coordinates = normalized.map((value) => value * length);
  const weights = new Array(n + 1);
  const faces = new Array(n);
  const edgeWidths = new Array(n);
  for (let i = 0; i <= n; i++) {
    const left = i === 0 ? 0 : 0.5 * (coordinates[i - 1] + coordinates[i]);
    const right = i === n ? length : 0.5 * (coordinates[i] + coordinates[i + 1]);
    weights[i] = 0.5 * (right * right - left * left);
  }
  for (let i = 0; i < n; i++) {
    faces[i] = 0.5 * (coordinates[i] + coordinates[i + 1]);
    edgeWidths[i] = coordinates[i + 1] - coordinates[i];
  }
  return { n, dx: length / n, dr: length / n, coordinates, radii: coordinates, weights, faces, edgeWidths, length, mesh };
}

function interpolateState(coordinates, state, coordinate) {
  if (coordinate <= coordinates[0]) return state[0];
  if (coordinate >= coordinates[coordinates.length - 1]) return state[state.length - 1];
  let lo = 0;
  let hi = coordinates.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (coordinates[mid] <= coordinate) lo = mid;
    else hi = mid;
  }
  const w = (coordinate - coordinates[lo]) / (coordinates[hi] - coordinates[lo]);
  return state[lo] * (1 - w) + state[hi] * w;
}

function heatCapacity(c, physics) {
  if (!(c > 0) || !Number.isFinite(c)) throw new Error(`热容量输入非法: ${c}`);
  if (physics === 'q3') return (650 + 128 * c) * (1450 + 2736 * c / (1 + c));
  return (760 + 90 * c) * (1850 + 2150 * c / (1 + c));
}

function conductivity(c, physics) {
  if (physics === 'q3') return 0.21 + 0.38 * c / (1 + c);
  return 0.12 + 0.20 * c / (1 + c);
}

function diffusionCoefficient(c, temperatureC, physics) {
  if (!(c > 0) || !Number.isFinite(c)) throw new Error(`扩散系数输入含水率非法: ${c}`);
  const temperatureK = temperatureC + 273.15;
  if (!(temperatureK > 0) || !Number.isFinite(temperatureK)) throw new Error(`扩散系数输入温度非法: ${temperatureC}`);
  if (physics === 'q3') return 2.4e-3 * Math.exp(-0.45 / c - 3850 / temperatureK);
  return 4.2e-4 * Math.exp(-0.30 / c - 3850 / temperatureK);
}

function harmonicMean(a, b) {
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`调和平均输入非法: ${a}, ${b}`);
  return (2 * a * b) / (a + b);
}

function nodeToFaceCoefficient(values) {
  return values.slice(0, -1).map((value, i) => harmonicMean(value, values[i + 1]));
}

function solveTridiagonal(lower, diagonal, upper, rhs) {
  const n = diagonal.length;
  const a = lower.slice();
  const b = diagonal.slice();
  const c = upper.slice();
  const d = rhs.slice();
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(b[i]) || Math.abs(b[i]) < 1e-30 || !Number.isFinite(d[i])) throw new Error(`三对角主元非法: ${i}`);
  }
  for (let i = 1; i < n; i++) {
    const factor = a[i] / b[i - 1];
    b[i] -= factor * c[i - 1];
    d[i] -= factor * d[i - 1];
    if (!Number.isFinite(b[i]) || Math.abs(b[i]) < 1e-30 || !Number.isFinite(d[i])) throw new Error(`三对角消元失败: ${i}`);
  }
  const x = new Array(n);
  x[n - 1] = d[n - 1] / b[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = (d[i] - c[i] * x[i + 1]) / b[i];
  if (x.some((value) => !Number.isFinite(value))) throw new Error('三对角解包含非有限值');
  return x;
}

function assembleLinearSystem(grid, oldState, dt, capacity, faceCoefficient, surfaceExchange, environment, interiorScale, source = null) {
  const size = grid.n + 1;
  const lower = new Array(size).fill(0);
  const diagonal = new Array(size).fill(0);
  const upper = new Array(size).fill(0);
  const rhs = new Array(size);
  for (let i = 0; i <= grid.n; i++) {
    const capacityI = Array.isArray(capacity) ? capacity[i] : capacity;
    const storage = capacityI * grid.weights[i] / dt;
    const left = i === 0 ? 0 : grid.faces[i - 1] * faceCoefficient[i - 1] * interiorScale / grid.edgeWidths[i - 1];
    const right = i === grid.n ? surfaceExchange : grid.faces[i] * faceCoefficient[i] * interiorScale / grid.edgeWidths[i];
    diagonal[i] = storage + left + right;
    rhs[i] = storage * oldState[i] + (source ? source[i] * grid.weights[i] : 0);
    if (i > 0) lower[i] = -left;
    if (i < grid.n) upper[i] = -right;
    if (i === grid.n) rhs[i] += surfaceExchange * environment;
  }
  return { lower, diagonal, upper, rhs };
}

function solveLinearStep(grid, oldState, dt, capacity, faceCoefficient, surfaceExchange, environment, interiorScale, source = null) {
  const system = assembleLinearSystem(grid, oldState, dt, capacity, faceCoefficient, surfaceExchange, environment, interiorScale, source);
  return solveTridiagonal(system.lower, system.diagonal, system.upper, system.rhs);
}

function fieldResidual(grid, oldState, newState, dt, capacity, faceCoefficient, surfaceExchange, environment, interiorScale, source = null) {
  let maxScaled = 0;
  let maxAbsolute = 0;
  for (let i = 0; i <= grid.n; i++) {
    const capacityI = Array.isArray(capacity) ? capacity[i] : capacity;
    const leftFlux = i === 0 ? 0 : -grid.faces[i - 1] * faceCoefficient[i - 1] * interiorScale * (newState[i] - newState[i - 1]) / grid.edgeWidths[i - 1];
    const rightFlux = i === grid.n
      ? surfaceExchange * (newState[i] - environment)
      : -grid.faces[i] * faceCoefficient[i] * interiorScale * (newState[i + 1] - newState[i]) / grid.edgeWidths[i];
    const sourceI = source ? source[i] : 0;
    const lhs = grid.weights[i] * capacityI * (newState[i] - oldState[i]) / dt;
    const residual = lhs - leftFlux + rightFlux - grid.weights[i] * sourceI;
    const scaled = Math.abs(residual) * dt / Math.max(1e-30, grid.weights[i] * capacityI);
    maxScaled = Math.max(maxScaled, scaled);
    maxAbsolute = Math.max(maxAbsolute, Math.abs(residual));
  }
  return { scaled: maxScaled, absolute: maxAbsolute };
}

function coupledStepQ4(grid, oldTemperature, oldMoisture, dt, environment, options = {}) {
  const physics = options.physics ?? 'q4';
  const kind = options.kind ?? 'material';
  const R = options.radius ?? R0;
  const heatExchangeCoefficient = options.heatExchangeCoefficient ?? H_T;
  const moistureExchangeCoefficient = options.moistureExchangeCoefficient ?? H_M;
  const interiorScale = kind === 'material' ? 1 / (R * R) : 1;
  const heatSurfaceExchange = kind === 'material' ? heatExchangeCoefficient / R : R * heatExchangeCoefficient;
  const moistureSurfaceExchange = kind === 'material' ? moistureExchangeCoefficient / R : R * moistureExchangeCoefficient;
  const maxIterations = options.maxIterations ?? 100;
  const temperatureUpdateTolerance = options.temperatureUpdateTolerance ?? 1e-8;
  const moistureUpdateTolerance = options.moistureUpdateTolerance ?? 1e-10;
  const residualTolerance = options.residualTolerance ?? 1e-8;
  const relaxation = options.relaxation ?? 0.8;
  let guessTemperature = oldTemperature.slice();
  let guessMoisture = oldMoisture.slice();
  let lastTemperatureResidual = { scaled: Infinity, absolute: Infinity };
  let lastMoistureResidual = { scaled: Infinity, absolute: Infinity };
  let lastTemperatureUpdate = Infinity;
  let lastMoistureUpdate = Infinity;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const nodeCapacity = guessMoisture.map((c) => heatCapacity(c, physics));
    const nodeK = guessMoisture.map((c) => conductivity(c, physics));
    const faceK = nodeToFaceCoefficient(nodeK);
    const temperatureSource = options.temperatureSource ? options.temperatureSource(grid, environment.time, R) : null;
    const rawTemperature = solveLinearStep(grid, oldTemperature, dt, nodeCapacity, faceK, heatSurfaceExchange, environment.temperature, interiorScale, temperatureSource);
    const nodeD = rawTemperature.map((temperature, i) => diffusionCoefficient(guessMoisture[i], temperature, physics));
    const faceD = nodeToFaceCoefficient(nodeD);
    const moistureSource = options.moistureSource ? options.moistureSource(grid, environment.time, R) : null;
    const rawMoisture = solveLinearStep(grid, oldMoisture, dt, 1, faceD, moistureSurfaceExchange, environment.moisture, interiorScale, moistureSource);
    const nextTemperature = guessTemperature.map((value, i) => value + relaxation * (rawTemperature[i] - value));
    const nextMoisture = guessMoisture.map((value, i) => value + relaxation * (rawMoisture[i] - value));
    if (nextMoisture.some((value) => !(value > 0) || !Number.isFinite(value)) || nextTemperature.some((value) => !Number.isFinite(value) || value + 273.15 <= 0)) {
      throw new Error(`Picard得到非法状态: T=${nextTemperature[0]}, C=${nextMoisture[0]}`);
    }
    const finalCapacity = nextMoisture.map((c) => heatCapacity(c, physics));
    const finalK = nodeToFaceCoefficient(nextMoisture.map((c) => conductivity(c, physics)));
    const finalD = nodeToFaceCoefficient(nextMoisture.map((c, i) => diffusionCoefficient(c, nextTemperature[i], physics)));
    lastTemperatureUpdate = maxAbsDiff(nextTemperature, guessTemperature);
    lastMoistureUpdate = maxAbsDiff(nextMoisture, guessMoisture);
    lastTemperatureResidual = fieldResidual(grid, oldTemperature, nextTemperature, dt, finalCapacity, finalK, heatSurfaceExchange, environment.temperature, interiorScale, temperatureSource);
    lastMoistureResidual = fieldResidual(grid, oldMoisture, nextMoisture, dt, 1, finalD, moistureSurfaceExchange, environment.moisture, interiorScale, moistureSource);
    guessTemperature = nextTemperature;
    guessMoisture = nextMoisture;
    if (lastTemperatureUpdate <= temperatureUpdateTolerance && lastMoistureUpdate <= moistureUpdateTolerance && lastTemperatureResidual.scaled <= residualTolerance && lastMoistureResidual.scaled <= residualTolerance) {
      return {
        temperature: guessTemperature,
        moisture: guessMoisture,
        iterations: iteration,
        temperatureUpdate: lastTemperatureUpdate,
        moistureUpdate: lastMoistureUpdate,
        temperatureResidual: lastTemperatureResidual,
        moistureResidual: lastMoistureResidual,
      };
    }
  }
  throw new Error(`双场 Picard 未收敛: T_update=${lastTemperatureUpdate}, C_update=${lastMoistureUpdate}, T_residual=${lastTemperatureResidual.scaled}, C_residual=${lastMoistureResidual.scaled}`);
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
  const weight = (time - points[lo][0]) / (points[hi][0] - points[lo][0]);
  return points[lo][1] * (1 - weight) + points[hi][1] * weight;
}

function trapezoidalWindowMean(cleanRows, column, windowSeconds) {
  const lastTime = cleanRows[cleanRows.length - 1][0];
  const startTime = lastTime - windowSeconds;
  if (!(windowSeconds > 0) || startTime < cleanRows[0][0]) throw new Error(`环境平均窗口超出数据范围: ${windowSeconds} s`);
  let integral = 0;
  let duration = 0;
  for (let i = 0; i < cleanRows.length - 1; i++) {
    const segmentStart = Math.max(startTime, cleanRows[i][0]);
    const segmentEnd = Math.min(lastTime, cleanRows[i + 1][0]);
    if (!(segmentEnd > segmentStart)) continue;
    const y0 = cleanRows[i][column] + (cleanRows[i + 1][column] - cleanRows[i][column]) * ((segmentStart - cleanRows[i][0]) / (cleanRows[i + 1][0] - cleanRows[i][0]));
    const y1 = cleanRows[i][column] + (cleanRows[i + 1][column] - cleanRows[i][column]) * ((segmentEnd - cleanRows[i][0]) / (cleanRows[i + 1][0] - cleanRows[i][0]));
    integral += 0.5 * (y0 + y1) * (segmentEnd - segmentStart);
    duration += segmentEnd - segmentStart;
  }
  if (Math.abs(duration - windowSeconds) > 1e-8) throw new Error(`环境平均窗口积分时长异常: ${duration} vs ${windowSeconds}`);
  return integral / duration;
}

function makeRefinedEnvironment(rows, extension = 'lastWindowMean', windowSeconds = 1800) {
  const cleanRows = rows
    .map((row) => [Number(row[0]), Number(row[1]), Number(row[2])])
    .filter((row) => row.every((value) => Number.isFinite(value)))
    .sort((a, b) => a[0] - b[0]);
  if (cleanRows.length < 2) throw new Error('附件1有效环境数据不足');
  for (let i = 1; i < cleanRows.length; i++) if (!(cleanRows[i][0] > cleanRows[i - 1][0])) throw new Error('附件1时间点不严格递增');
  const temperaturePoints = cleanRows.map((row) => [row[0], row[1]]);
  const moisturePoints = cleanRows.map((row) => [row[0], row[2]]);
  const lastTime = cleanRows[cleanRows.length - 1][0];
  const endpoint = cleanRows[cleanRows.length - 1];
  const windowMean = {
    temperature: trapezoidalWindowMean(cleanRows, 1, windowSeconds),
    moisture: trapezoidalWindowMean(cleanRows, 2, windowSeconds),
  };
  const tailPoints = cleanRows.filter((row) => row[0] >= lastTime - windowSeconds - 1e-8);
  const environment = {
    extension,
    windowSeconds,
    windowStart: lastTime - windowSeconds,
    windowMethod: 'trapezoidal',
    windowPointCount: tailPoints.length,
    lastTime,
    temperaturePoints,
    moisturePoints,
    endpoint: { temperature: endpoint[1], moisture: endpoint[2] },
    lastHourMean: windowMean,
    lastWindowMean: windowMean,
    temperature: (time) => {
      if (time <= lastTime) return linearInterpolatePoints(temperaturePoints, time);
      return extension === 'lastValue' ? endpoint[1] : windowMean.temperature;
    },
    moisture: (time) => {
      if (time <= lastTime) return linearInterpolatePoints(moisturePoints, time);
      return extension === 'lastValue' ? endpoint[2] : windowMean.moisture;
    },
  };
  return environment;
}

async function loadRefinedEnvironment(extension = 'lastWindowMean', windowSeconds = 1800) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(environmentInputPath));
  const sheet = workbook.worksheets.getItemAt(0);
  const rows = sheet.getUsedRange(true).values.slice(1).filter((row) => row[0] !== null && row[0] !== undefined);
  const environment = makeRefinedEnvironment(rows, extension, windowSeconds);
  if (environment.temperaturePoints.length !== 241) throw new Error(`附件1环境点数量不是241: ${environment.temperaturePoints.length}`);
  return environment;
}

function cleanRadiusRows(rows) {
  const clean = rows.map((row) => [Number(row[0]), Number(row[1]) / 100]).filter((row) => row.every((value) => Number.isFinite(value))).sort((a, b) => a[0] - b[0]);
  if (clean.length < 2) throw new Error('附件2有效半径点不足');
  for (let i = 1; i < clean.length; i++) {
    if (!(clean[i][0] > clean[i - 1][0])) throw new Error('附件2时间点不严格递增');
    if (!(clean[i][1] > 0) || clean[i][1] > clean[i - 1][1] + 1e-12) throw new Error('附件2半径必须为正且非增');
  }
  return clean;
}

function endpointSlope(h0, h1, delta0, delta1) {
  let slope = ((2 * h0 + h1) * delta0 - h0 * delta1) / (h0 + h1);
  if (Math.sign(slope) !== Math.sign(delta0)) slope = 0;
  else if (Math.sign(delta0) !== Math.sign(delta1) && Math.abs(slope) > 3 * Math.abs(delta0)) slope = 3 * delta0;
  return slope;
}

function pchipSlopes(points) {
  const count = points.length;
  const h = new Array(count - 1);
  const delta = new Array(count - 1);
  for (let i = 0; i < count - 1; i++) {
    h[i] = points[i + 1][0] - points[i][0];
    delta[i] = (points[i + 1][1] - points[i][1]) / h[i];
  }
  const slopes = new Array(count).fill(0);
  if (count === 2) {
    slopes[0] = delta[0];
    slopes[1] = delta[0];
    return slopes;
  }
  slopes[0] = endpointSlope(h[0], h[1], delta[0], delta[1]);
  slopes[count - 1] = endpointSlope(h[count - 2], h[count - 3], delta[count - 1], delta[count - 2]);
  for (let i = 1; i < count - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      slopes[i] = 0;
      continue;
    }
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    slopes[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
  }
  return slopes;
}

function linearRadiusAt(points, time) {
  if (time <= points[0][0]) return points[0][1];
  if (time >= points[points.length - 1][0]) return points[points.length - 1][1];
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid][0] <= time) lo = mid;
    else hi = mid;
  }
  const [t0, r0] = points[lo];
  const [t1, r1] = points[hi];
  return r0 + ((time - t0) / (t1 - t0)) * (r1 - r0);
}

function pchipRadiusAt(points, slopes, time) {
  if (time <= points[0][0]) return points[0][1];
  if (time >= points[points.length - 1][0]) return points[points.length - 1][1];
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid][0] <= time) lo = mid;
    else hi = mid;
  }
  const h = points[hi][0] - points[lo][0];
  const s = (time - points[lo][0]) / h;
  const h00 = (1 + 2 * s) * (1 - s) ** 2;
  const h10 = s * (1 - s) ** 2;
  const h01 = s ** 2 * (3 - 2 * s);
  const h11 = s ** 2 * (s - 1);
  return h00 * points[lo][1] + h10 * h * slopes[lo] + h01 * points[hi][1] + h11 * h * slopes[hi];
}

function weibullRadiusAt(time, lastTime, terminalRadius) {
  if (time <= 0) return R0;
  if (time >= lastTime) return terminalRadius;
  return (1.1994 + 0.8006 * Math.exp(-((time / 13306) ** 0.8713))) / 100;
}

function makeRadiusModel(rows, method = 'pchip') {
  if (!['linear', 'pchip', 'weibull'].includes(method)) throw new Error(`未知半径方法: ${method}`);
  const points = cleanRadiusRows(rows);
  const slopes = method === 'pchip' ? pchipSlopes(points) : null;
  const lastTime = points[points.length - 1][0];
  const terminalRadius = points[points.length - 1][1];
  const radius = method === 'linear'
    ? (time) => linearRadiusAt(points, time)
    : method === 'pchip'
      ? (time) => pchipRadiusAt(points, slopes, time)
      : (time) => weibullRadiusAt(time, lastTime, terminalRadius);
  const checkTimes = [];
  for (let i = 0; i < points.length - 1; i++) for (let j = 0; j <= 10; j++) checkTimes.push(points[i][0] + (points[i + 1][0] - points[i][0]) * j / 10);
  const intervalViolations = [];
  for (const time of checkTimes) {
    let i = points.length - 2;
    for (let k = 0; k < points.length - 1; k++) {
      if (time < points[k + 1][0]) {
        i = k;
        break;
      }
    }
    const lo = points[i][1];
    const hi = points[i + 1][1];
    const value = radius(time);
    if (!(value > 0)) throw new Error(`半径${method}插值出现非正值: t=${time}, R=${value}`);
    if (value > lo + 1e-10 || value < hi - 1e-10) {
      if (method !== 'weibull') throw new Error(`半径${method}插值越过相邻测点: t=${time}, R=${value}`);
      intervalViolations.push({ time, lower: hi, upper: lo, value });
    }
  }
  const residuals = points.map(([time, value]) => ({ time, observed: value, fitted: radius(time), residual: radius(time) - value }));
  return { points, lastTime, terminalRadius, method, slopes, residuals, intervalViolations, radius };
}

async function loadRadiusModel(method = 'pchip') {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(radiusInputPath));
  const sheet = workbook.worksheets.getItemAt(0);
  return makeRadiusModel(sheet.getUsedRange(true).values.slice(1), method);
}

function constantRadiusModel(radius = R0) {
  return { points: [[0, radius]], lastTime: Infinity, terminalRadius: radius, method: 'fixed', residuals: [], intervalViolations: [], radius: () => radius };
}

function outputTimes(tEnd, interval) {
  const times = [];
  for (let t = 0; t <= tEnd + 1e-8; t += interval) times.push(Math.round(Math.min(t, tEnd) * 1e8) / 1e8);
  if (times[times.length - 1] < tEnd - 1e-8) times.push(tEnd);
  return times;
}

function defaultCheckpointTimes(tEnd) {
  return [0, 6 * 3600, 12 * 3600, 18 * 3600, 24 * 3600, 30 * 3600, 36 * 3600, 42 * 3600, 48 * 3600, 54 * 3600, 60 * 3600, 66 * 3600, 72 * 3600]
    .filter((time) => time <= tEnd + 1e-8);
}

function emptyStore() {
  return { times: [], radius: [], temperature: [], moisture: [], surfaceTemperature: [], surfaceMoisture: [], meanMoisture: [], maximumMoisture: [], maximumMoistureIndex: [] };
}

function samplePhysical(grid, state, radius) {
  return OUTPUT_RADII.map((physicalRadius) => physicalRadius >= radius - 1e-12 ? null : interpolateState(grid.coordinates, state, physicalRadius / radius));
}

function storeRecord(store, time, grid, temperature, moisture, radius, kind) {
  const maximum = maxAndIndex(moisture);
  const physicalTemperature = kind === 'material' ? samplePhysical(grid, temperature, radius) : OUTPUT_RADII.map((value) => value >= radius - 1e-12 ? null : interpolateState(grid.coordinates, temperature, value));
  const physicalMoisture = kind === 'material' ? samplePhysical(grid, moisture, radius) : OUTPUT_RADII.map((value) => value >= radius - 1e-12 ? null : interpolateState(grid.coordinates, moisture, value));
  store.times.push(time);
  store.radius.push(radius);
  store.temperature.push(physicalTemperature);
  store.moisture.push(physicalMoisture);
  store.surfaceTemperature.push(temperature[grid.n]);
  store.surfaceMoisture.push(moisture[grid.n]);
  store.meanMoisture.push(kind === 'material' ? 2 * sumWeighted(grid, moisture) : 2 * sumWeighted(grid, moisture) / (radius * radius));
  store.maximumMoisture.push(maximum.value);
  store.maximumMoistureIndex.push(maximum.index);
}

function geometryOptions(options, radius) {
  const kind = options.kind ?? 'material';
  const heatExchangeCoefficient = options.heatExchangeCoefficient ?? H_T;
  const moistureExchangeCoefficient = options.moistureExchangeCoefficient ?? H_M;
  return {
    kind,
    radius,
    heatExchangeCoefficient,
    moistureExchangeCoefficient,
  };
}

function manufacturedFields(time, x, radius) {
  const et = Math.exp(-time / 600);
  const ec = Math.exp(-time / 900);
  const temperature = 28 + 2 * et * (1 + x * x);
  const moisture = 1 + 0.2 * ec * (1 + 0.5 * x * x);
  const temperatureT = -(2 / 600) * et * (1 + x * x);
  const temperatureX = 4 * et * x;
  const temperatureXX = 4 * et;
  const moistureT = -(0.2 / 900) * ec * (1 + 0.5 * x * x);
  const moistureX = 0.2 * ec * x;
  const moistureXX = 0.2 * ec;
  const k = conductivity(moisture, 'q4');
  const d = diffusionCoefficient(moisture, temperature, 'q4');
  const dkdc = 0.20 / ((1 + moisture) * (1 + moisture));
  const dDdc = 0.30 * d / (moisture * moisture);
  const dDdT = 3850 * d / ((temperature + 273.15) * (temperature + 273.15));
  const temperatureLap = x === 0 ? 8 * et : temperatureXX + temperatureX / x;
  const moistureLap = x === 0 ? 0.4 * ec : moistureXX + moistureX / x;
  const temperatureSource = heatCapacity(moisture, 'q4') * temperatureT - (k * temperatureLap + dkdc * moistureX * temperatureX) / (radius * radius);
  const moistureSource = moistureT - (d * moistureLap + dDdc * moistureX * moistureX + dDdT * temperatureX * moistureX) / (radius * radius);
  return { temperature, moisture, temperatureX, moistureX, temperatureSource, moistureSource };
}

function manufacturedEnvironment(time, radius) {
  const surface = manufacturedFields(time, 1, radius);
  return {
    time,
    temperature: surface.temperature + conductivity(surface.moisture, 'q4') * surface.temperatureX / (radius * H_T),
    moisture: surface.moisture + diffusionCoefficient(surface.moisture, surface.temperature, 'q4') * surface.moistureX / (radius * H_M),
  };
}

function manufacturedSource(field) {
  return (grid, time, radius) => grid.coordinates.map((x) => manufacturedFields(time, x, radius)[field]);
}

function makeStepOptions(options, radius, time) {
  return {
    ...geometryOptions(options, radius),
    physics: options.physics ?? 'q4',
    relaxation: options.relaxation,
    maxIterations: options.maxIterations,
    temperatureUpdateTolerance: options.temperatureUpdateTolerance,
    moistureUpdateTolerance: options.moistureUpdateTolerance,
    residualTolerance: options.residualTolerance,
    temperatureSource: options.manufactured ? manufacturedSource('temperatureSource') : null,
    moistureSource: options.manufactured ? manufacturedSource('moistureSource') : null,
  };
}

function refineThreshold(environment, radiusModel, leftTime, leftTemperature, leftMoisture, rightTime, options) {
  let lo = leftTime;
  let hi = rightTime;
  let hiTemperature = null;
  let hiMoisture = null;
  for (let iteration = 0; iteration < 34 && hi - lo > 1e-3; iteration++) {
    const mid = 0.5 * (lo + hi);
    const radius = radiusModel.radius(mid);
    const values = options.manufactured ? manufacturedEnvironment(mid, radius) : { temperature: environment.temperature(mid), moisture: environment.moisture(mid) };
    const step = coupledStepQ4(options.grid, leftTemperature, leftMoisture, mid - leftTime, { time: mid, ...values }, makeStepOptions(options, radius, mid));
    if (Math.max(...step.moisture) < THRESHOLD_C) {
      hi = mid;
      hiTemperature = step.temperature;
      hiMoisture = step.moisture;
    } else {
      lo = mid;
    }
  }
  if (!hiTemperature) {
    const radius = radiusModel.radius(hi);
    const values = options.manufactured ? manufacturedEnvironment(hi, radius) : { temperature: environment.temperature(hi), moisture: environment.moisture(hi) };
    const step = coupledStepQ4(options.grid, leftTemperature, leftMoisture, hi - leftTime, { time: hi, ...values }, makeStepOptions(options, radius, hi));
    hiTemperature = step.temperature;
    hiMoisture = step.moisture;
  }
  return { time: hi, temperature: hiTemperature, moisture: hiMoisture, bracket: [lo, hi] };
}

function simulateQuestion4(environment, radiusModel, options = {}) {
  const n = options.n ?? 160;
  const requestedDt = options.dt ?? 1;
  const tEnd = options.tEnd ?? DEFAULT_MAX_T;
  const outputInterval = options.outputInterval ?? 60;
  const kind = options.kind ?? 'material';
  const physics = options.physics ?? 'q4';
  const requestedTimes = options.storeTimes ?? outputTimes(tEnd, outputInterval);
  const checkpointTimes = [...new Set((options.checkpointTimes ?? defaultCheckpointTimes(tEnd)).filter((time) => time >= 0 && time <= tEnd + 1e-8).map((time) => Number(time)))].sort((a, b) => a - b);
  const grid = gridForCoordinate(n, kind === 'material' ? 1 : R0, options.mesh ?? 'surfaceRefined');
  let temperature = options.initialTemperature?.slice() ?? new Array(n + 1).fill(T0);
  let moisture = options.initialMoisture?.slice() ?? new Array(n + 1).fill(C0);
  const store = emptyStore();
  const stateCheckpoints = [];
  const balance = {
    initialMoistureIntegral: sumWeighted(grid, moisture),
    cumulativeBoundaryMoistureOutflow: 0,
    cumulativeBoundaryHeatOutflow: 0,
    initialThermalStorage: sumWeighted(grid, moisture.map((c, i) => heatCapacity(c, physics) * temperature[i])),
    cumulativeThermalStorageChange: 0,
    maxPicardIterations: 0,
    maxPicardTemperatureResidual: 0,
    maxPicardMoistureResidual: 0,
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
  let previousMaximum = Math.max(...moisture);
  let thresholdEvent = null;
  let endpointState = null;
  const stageCrossings = {};
  const recordCheckpoint = (time, radius, type = 'scheduled') => {
    stateCheckpoints.push({
      time,
      radius,
      type,
      temperature: temperature.slice(),
      moisture: moisture.slice(),
      maximumMoisture: Math.max(...moisture),
      maximumMoistureIndex: maxAndIndex(moisture).index,
    });
  };
  const checkpointDue = (time, radius) => {
    while (checkpointIndex < checkpointTimes.length && checkpointTimes[checkpointIndex] <= time + 1e-8) {
      if (Math.abs(checkpointTimes[checkpointIndex] - time) > 1e-8) throw new Error(`检查点时间未准确落点: ${checkpointTimes[checkpointIndex]} vs ${time}`);
      recordCheckpoint(time, radius);
      checkpointIndex++;
    }
  };
  const accept = (oldTemperature, oldMoisture, newTemperature, newMoisture, dtUsed, env, step, radius) => {
    const factors = geometryOptions(options, radius);
    const moistureExchange = kind === 'material' ? factors.moistureExchangeCoefficient / radius : radius * factors.moistureExchangeCoefficient;
    const heatExchange = kind === 'material' ? factors.heatExchangeCoefficient / radius : radius * factors.heatExchangeCoefficient;
    balance.cumulativeBoundaryMoistureOutflow += dtUsed * moistureExchange * (newMoisture[grid.n] - env.moisture);
    balance.cumulativeBoundaryHeatOutflow += dtUsed * heatExchange * (newTemperature[grid.n] - env.temperature);
    balance.cumulativeThermalStorageChange += sumWeighted(grid, newTemperature.map((value, i) => heatCapacity(newMoisture[i], physics) * (value - oldTemperature[i])));
    balance.maxPicardIterations = Math.max(balance.maxPicardIterations, step.iterations);
    balance.maxPicardTemperatureResidual = Math.max(balance.maxPicardTemperatureResidual, step.temperatureResidual.scaled);
    balance.maxPicardMoistureResidual = Math.max(balance.maxPicardMoistureResidual, step.moistureResidual.scaled);
    balance.acceptedSteps++;
    balance.minAcceptedDt = Math.min(balance.minAcceptedDt, dtUsed);
    balance.maxAcceptedDt = Math.max(balance.maxAcceptedDt, dtUsed);
    balance.minTemperature = Math.min(balance.minTemperature, ...newTemperature);
    balance.maxTemperature = Math.max(balance.maxTemperature, ...newTemperature);
    balance.minMoisture = Math.min(balance.minMoisture, ...newMoisture);
    balance.maxMoisture = Math.max(balance.maxMoisture, ...newMoisture);
  };
  const recordDue = (time, radius) => {
    while (outputIndex < requestedTimes.length && requestedTimes[outputIndex] <= time + 1e-8) {
      if (Math.abs(requestedTimes[outputIndex] - time) > 1e-8) throw new Error(`输出时间未准确落点: ${requestedTimes[outputIndex]} vs ${time}`);
      storeRecord(store, time, grid, temperature, moisture, radius, kind);
      outputIndex++;
    }
  };
  const initialRadius = radiusModel.radius(0);
  recordDue(0, initialRadius);
  checkpointDue(0, initialRadius);
  while (t < tEnd - 1e-10) {
    const target = requestedTimes[outputIndex] ?? tEnd;
    const dtStep = Math.min(dt, target - t, tEnd - t);
    if (!(dtStep > 0)) {
      if (Math.abs(target - t) < 1e-8) { outputIndex++; continue; }
      throw new Error(`时间推进目标异常: t=${t}, target=${target}, dt=${dt}`);
    }
    const oldTime = t;
    const oldTemperature = temperature;
    const oldMoisture = moisture;
    const oldMaximum = previousMaximum;
    try {
      const nextTime = oldTime + dtStep;
      const radius = radiusModel.radius(nextTime);
      const values = options.manufactured ? manufacturedEnvironment(nextTime, radius) : { temperature: environment.temperature(nextTime), moisture: environment.moisture(nextTime) };
      const step = coupledStepQ4(grid, oldTemperature, oldMoisture, dtStep, { time: nextTime, ...values }, { ...makeStepOptions({ ...options, physics }, radius, nextTime), grid });
      const newMaximum = Math.max(...step.moisture);
      if (oldMaximum > THRESHOLD_C && newMaximum <= THRESHOLD_C) {
        const refined = refineThreshold(environment, radiusModel, oldTime, oldTemperature, oldMoisture, nextTime, { ...options, physics, grid });
        const refinedRadius = radiusModel.radius(refined.time);
        const refinedValues = options.manufactured ? manufacturedEnvironment(refined.time, refinedRadius) : { temperature: environment.temperature(refined.time), moisture: environment.moisture(refined.time) };
        const refinedStep = coupledStepQ4(grid, oldTemperature, oldMoisture, refined.time - oldTime, { time: refined.time, ...refinedValues }, { ...makeStepOptions({ ...options, physics }, refinedRadius, refined.time), grid });
        accept(oldTemperature, oldMoisture, refinedStep.temperature, refinedStep.moisture, refined.time - oldTime, refinedValues, refinedStep, refinedRadius);
        t = refined.time;
        temperature = refinedStep.temperature;
        moisture = refinedStep.moisture;
        for (const threshold of STAGE_THRESHOLDS) {
          if (oldMaximum > threshold && newMaximum <= threshold && stageCrossings[threshold] === undefined) {
            const fraction = (threshold - oldMaximum) / (newMaximum - oldMaximum);
            stageCrossings[threshold] = oldTime + Math.max(0, Math.min(1, fraction)) * dtStep;
          }
        }
        stageCrossings[THRESHOLD_C] = t;
        thresholdEvent = { bracket: refined.bracket, confirmedTime: t, confirmedMaximum: Math.max(...moisture), confirmedIndex: maxAndIndex(moisture).index, criterion: 'max over all internal x nodes < 0.15 kg/kg' };
        endpointState = { time: t, temperature: temperature.slice(), moisture: moisture.slice(), radius: refinedRadius };
        recordDue(t, refinedRadius);
        recordCheckpoint(t, refinedRadius, 'threshold');
        break;
      }
      accept(oldTemperature, oldMoisture, step.temperature, step.moisture, dtStep, values, step, radius);
      t = nextTime;
      temperature = step.temperature;
      moisture = step.moisture;
      previousMaximum = newMaximum;
      for (const threshold of STAGE_THRESHOLDS) {
        if (oldMaximum > threshold && newMaximum <= threshold && stageCrossings[threshold] === undefined) {
          const fraction = (threshold - oldMaximum) / (newMaximum - oldMaximum);
          stageCrossings[threshold] = oldTime + Math.max(0, Math.min(1, fraction)) * dtStep;
        }
      }
      recordDue(t, radius);
      checkpointDue(t, radius);
      dt = Math.min(requestedDt, dt * 2);
    } catch (error) {
      if (dt <= requestedDt / 128) throw error;
      dt *= 0.5;
      balance.rejectedSteps++;
    }
  }
  const lastState = { time: t, temperature: temperature.slice(), moisture: moisture.slice(), radius: radiusModel.radius(t) };
  if (!thresholdEvent && Math.abs(t - tEnd) < 1e-8) checkpointDue(t, lastState.radius);
  if (!checkpointTimes.some((time) => Math.abs(time - lastState.time) < 1e-8)) recordCheckpoint(lastState.time, lastState.radius, thresholdEvent ? 'threshold' : 'budget');
  balance.finalMoistureIntegral = sumWeighted(grid, moisture);
  balance.integralMoistureLoss = balance.initialMoistureIntegral - balance.finalMoistureIntegral;
  const finalRadius = radiusModel.radius(t);
  balance.moistureBalanceError = balance.integralMoistureLoss - balance.cumulativeBoundaryMoistureOutflow;
  balance.moistureBalanceErrorRelative = balance.moistureBalanceError / Math.max(1e-30, Math.abs(balance.initialMoistureIntegral));
  balance.thermalStorageBalanceError = balance.cumulativeThermalStorageChange + balance.cumulativeBoundaryHeatOutflow;
  balance.thermalStorageBalanceErrorRelative = balance.thermalStorageBalanceError / Math.max(1, Math.abs(balance.initialThermalStorage));
  balance.finalTime = t;
  balance.finalRadius = finalRadius;
  balance.thresholdEvent = thresholdEvent;
  const slopeWindows = {};
  for (const window of [60, 300, 600]) {
    const last = store.times.length - 1;
    let first = 0;
    for (let i = 0; i < store.times.length; i++) if (store.times[i] <= t - window + 1e-8) first = i;
    if (last > first && store.times[last] > store.times[first]) slopeWindows[window] = {
      slope: (store.maximumMoisture[last] - store.maximumMoisture[first]) / (store.times[last] - store.times[first]),
      actualWindow_s: store.times[last] - store.times[first],
      startTime_s: store.times[first],
      endTime_s: store.times[last],
    };
  }
  return { grid, store, stateCheckpoints, balance, requestedDt, tEnd, outputInterval, kind, physics, finalTemperature: temperature, finalMoisture: moisture, stageCrossings, slopeWindows, endpointState, lastState, radiusModel, finalRadius, thresholdEvent };
}

function runTests() {
  const environment = makeConstantEnvironment(T0, C0);
  const fixed = constantRadiusModel(R0);
  const materialFixed = simulateQuestion4(environment, fixed, { n: 16, dt: 0.5, tEnd: 5, outputInterval: 5, kind: 'material', physics: 'q4' });
  const physicalFixed = simulateQuestion4(environment, fixed, { n: 16, dt: 0.5, tEnd: 5, outputInterval: 5, kind: 'physical', physics: 'q4' });
  const initialUniform = new Array(17).fill(C0);
  const moving = { points: [[0, R0], [10, 0.015], [20, 0.012]], lastTime: 20, radius: (time) => time <= 10 ? R0 - 0.0005 * time : 0.015 - 0.0003 * (time - 10) };
  const uniform = simulateQuestion4(environment, moving, { n: 16, dt: 0.5, tEnd: 20, outputInterval: 20, kind: 'material', physics: 'q4', initialMoisture: initialUniform, heatExchangeCoefficient: 0, moistureExchangeCoefficient: 0 });
  const nonuniformInitial = Array.from({ length: 17 }, (_, i) => 1.2 + 0.4 * (i / 16) ** 2);
  const nonuniform = simulateQuestion4(environment, moving, { n: 16, dt: 0.5, tEnd: 20, outputInterval: 20, kind: 'material', physics: 'q4', initialMoisture: nonuniformInitial, heatExchangeCoefficient: 0, moistureExchangeCoefficient: 0 });
  const initialIntegral = sumWeighted(nonuniform.grid, nonuniformInitial);
  const manufacturedRadius = { points: [[0, R0], [30, 0.017]], lastTime: 30, radius: (time) => R0 - 0.0001 * time };
  const manufacturedGrid = gridForCoordinate(20, 1);
  const manufacturedInitial = manufacturedGrid.coordinates.map((x) => manufacturedFields(0, x, R0));
  const manufactured = simulateQuestion4(makeConstantEnvironment(0, 0), manufacturedRadius, { n: 20, dt: 0.25, tEnd: 30, outputInterval: 30, kind: 'material', physics: 'q4', manufactured: true, initialTemperature: manufacturedInitial.map((value) => value.temperature), initialMoisture: manufacturedInitial.map((value) => value.moisture) });
  const exactFinal = manufacturedGrid.coordinates.map((x) => manufacturedFields(30, x, manufacturedRadius.radius(30)));
  return {
    fixedRadiusTemperatureMaxDifference: maxAbsDiff(materialFixed.finalTemperature, physicalFixed.finalTemperature),
    fixedRadiusMoistureMaxDifference: maxAbsDiff(materialFixed.finalMoisture, physicalFixed.finalMoisture),
    closedUniformMaxChange: maxAbsDiff(uniform.finalMoisture, initialUniform),
    closedNonuniformRelativeIntegralError: Math.abs(sumWeighted(nonuniform.grid, nonuniform.finalMoisture) - initialIntegral) / Math.max(1, Math.abs(initialIntegral)),
    manufacturedTemperatureMaxError: maxAbsDiff(manufactured.finalTemperature, exactFinal.map((value) => value.temperature)),
    manufacturedMoistureMaxError: maxAbsDiff(manufactured.finalMoisture, exactFinal.map((value) => value.moisture)),
  };
}

function csv(rows) {
  return rows.map((row) => row.map((value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[,"\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\n') + '\n';
}

function compareCases(cases) {
  const getTime = (result) => result.balance.thresholdEvent ? result.balance.thresholdEvent.confirmedTime / 3600 : null;
  const t00 = getTime(cases.t00);
  const t10 = getTime(cases.t10);
  const t01 = getTime(cases.t01);
  const t11 = getTime(cases.t11);
  const complete = [t00, t10, t01, t11].every((value) => value !== null);
  const bracketWidth = Object.fromEntries(Object.entries(cases).map(([key, value]) => [key, value.balance.thresholdEvent ? (value.balance.thresholdEvent.bracket[1] - value.balance.thresholdEvent.bracket[0]) / 3600 : null]));
  if (!complete) {
    return {
      status: 'incomplete; at least one case did not reach max(C)<0.15 within the budget',
      times_h: { t00, t10, t01, t11 },
      event_bracket_width_h: bracketWidth,
      interaction_h: null,
      property_effect_h: null,
      geometry_effect_h: null,
      decomposition_check_h: null,
    };
  }
  const interaction = t11 - t10 - t01 + t00;
  const property = 0.5 * ((t10 - t00) + (t11 - t01));
  const geometry = 0.5 * ((t01 - t00) + (t11 - t10));
  return { status: 'complete; all four cases reached max(C)<0.15', times_h: { t00, t10, t01, t11 }, event_bracket_width_h: bracketWidth, interaction_h: interaction, property_effect_h: property, geometry_effect_h: geometry, decomposition_check_h: property + geometry - (t11 - t00) };
}

function comparisonMarkdown(comparison) {
  const t = comparison.times_h;
  const fmt = (value) => value === null || value === undefined ? '' : value.toFixed(6);
  return [
    '# A题第四问四组时间对照', '',
    `状态：${comparison.status ?? '未记录'}。`, '',
    '| 记号 | 物性 | 半径历史 | 达标时刻/h |',
    '|---|---|---|---:|',
    `| t00 | 附录3 | 固定 R₀ | ${fmt(t.t00)} |`,
    `| t10 | 附录4 | 固定 R₀ | ${fmt(t.t10)} |`,
    `| t01 | 附录3 | 附件2收缩 | ${fmt(t.t01)} |`,
    `| t11 | 附录4 | 附件2收缩 | ${fmt(t.t11)} |`,
    '',
    `- 物性对称分摊：${fmt(comparison.property_effect_h)} h。`,
    `- 几何对称分摊：${fmt(comparison.geometry_effect_h)} h。`,
    `- 事件括区宽度（不是总误差）：${Object.entries(comparison.event_bracket_width_h ?? {}).map(([key, value]) => `${key}=${fmt(value)}`).join('；')}。`,
    `- 交互项：${fmt(comparison.interaction_h)} h；分解残差：${comparison.decomposition_check_h === null || comparison.decomposition_check_h === undefined ? '' : comparison.decomposition_check_h.toExponential(3)} h。`,
    '- 正值表示增加时长，负值表示缩短时长；两项已按顺序平均分摊交互影响。',
  ].join('\n');
}

function table6(result) {
  const reportTimes = [0, 6 * 3600, 12 * 3600, 18 * 3600, 24 * 3600, 30 * 3600, 36 * 3600, 42 * 3600, 48 * 3600, 54 * 3600, 60 * 3600, 66 * 3600, 72 * 3600];
  const positions = TABLE6_RADII.map((radius) => OUTPUT_RADII.findIndex((value) => Math.abs(value - radius) < 1e-12));
  const reportRows = [...reportTimes];
  if (result.thresholdEvent && !reportRows.some((time) => Math.abs(time - result.thresholdEvent.confirmedTime) < 1e-8)) reportRows.push(result.thresholdEvent.confirmedTime);
  reportRows.sort((a, b) => a - b);
  const lines = ['# A题第四问表6', '', '单位：时间为 h，空间列为物理半径/cm；域外留空，表面列为 C(1,t)。', '', '## 温度', '', `| 时间/h | ${positions.map((i) => OUTPUT_RADII[i] * 100).join(' | ')} | 药材表面 |`, '|---:|' + positions.map(() => '---:').join('|') + '|---:|'];
  const add = (records, digits) => {
    for (const time of reportRows) {
      const i = result.store.times.findIndex((value) => Math.abs(value - time) < 1e-8);
      if (i < 0) continue;
      lines.push(`| ${(time / 3600).toFixed(4)} | ${positions.map((j) => records[i][j] === null ? '' : records[i][j].toFixed(digits)).join(' | ')} | ${result.store.surfaceTemperature[i].toFixed(digits)} |`);
    }
  };
  add(result.store.temperature, 4);
  lines.push('', '## 水分浓度', '', `| 时间/h | ${positions.map((i) => OUTPUT_RADII[i] * 100).join(' | ')} | 药材表面 |`, '|---:|' + positions.map(() => '---:').join('|') + '|---:|');
  for (const time of reportRows) {
    const i = result.store.times.findIndex((value) => Math.abs(value - time) < 1e-8);
    if (i < 0) continue;
    lines.push(`| ${(time / 3600).toFixed(4)} | ${positions.map((j) => result.store.moisture[i][j] === null ? '' : result.store.moisture[i][j].toFixed(4)).join(' | ')} | ${result.store.surfaceMoisture[i].toFixed(4)} |`);
  }
  if (result.endpointState) lines.push('', `结束时刻完整行：${(result.endpointState.time / 3600).toFixed(6)} h；R=${result.endpointState.radius * 100} cm；全域最大含水率=${Math.max(...result.endpointState.moisture).toFixed(8)} kg/kg。`);
  else lines.push('', `状态：截至预算 ${(result.lastState.time / 3600).toFixed(6)} h 未达到 max(C)<0.15。`);
  return lines.join('\n');
}

function buildWorkbook(result, title, comparison) {
  const workbook = Workbook.create();
  const summary = workbook.worksheets.add('终点摘要');
  const temperatureSheet = workbook.worksheets.add('温度');
  const moistureSheet = workbook.worksheets.add('水分浓度');
  const t = comparison?.times_h;
  const summaryRows = [
    ['A题第四问：收缩圆柱双场模型', '', '', ''],
    ['指标', '数值', '单位', '说明'],
    ['确认结束时刻', result.endpointState ? result.endpointState.time / 3600 : null, 'h', result.endpointState ? '确认 max(C)<0.15' : '72 h预算内未达标'],
    ['终点半径', result.endpointState ? result.endpointState.radius * 100 : result.finalRadius * 100, 'cm', '附件2分段线性插值'],
    ['终止时全域最大含水率', result.endpointState ? Math.max(...result.endpointState.moisture) : Math.max(...result.finalMoisture), 'kg/kg', '未舍入值'],
    ['终点最大值位置', result.balance.thresholdEvent ? result.balance.thresholdEvent.confirmedIndex / result.grid.n : null, 'x', '材料坐标内部网格节点'],
    ['物性对称分摊', t ? comparison.property_effect_h : null, 'h', '四组对照'],
    ['几何对称分摊', t ? comparison.geometry_effect_h : null, 'h', '四组对照'],
    ['交互项', t ? comparison.interaction_h : null, 'h', '四组对照'],
    ['水分收支差', result.balance.moistureBalanceError, '归一化积分', '固定材料坐标权重'],
  ];
  summary.showGridLines = false;
  summary.getRangeByIndexes(0, 0, summaryRows.length, 4).values = summaryRows;
  summary.getRange('A1:D1').merge();
  summary.getRange('A1:D1').format = { font: { name: 'Arial', size: 14, bold: true, color: '#1F1F1F' }, verticalAlignment: 'center' };
  summary.getRange('A2:D2').format = { fill: '#1F4E78', font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center', verticalAlignment: 'center' };
  summary.getRange('A1:D10').format.font = { name: 'Arial', size: 10, color: '#222222' };
  summary.getRange('A1:D1').format.font = { name: 'Arial', size: 14, bold: true, color: '#1F1F1F' };
  summary.getRange('B3:B10').format.numberFormat = '0.000000';
  summary.getRange('A1:D10').format.verticalAlignment = 'center';
  summary.getRange('A1:D10').format.borders = { insideHorizontal: { style: 'thin', color: '#D9E2F3' }, bottom: { style: 'thin', color: '#A6A6A6' } };
  summary.getRange('A1:A10').format.columnWidth = 29;
  summary.getRange('B1:B10').format.columnWidth = 16;
  summary.getRange('C1:C10').format.columnWidth = 16;
  summary.getRange('D1:D10').format.columnWidth = 30;
  const header = ['时间/s 物理半径/cm', ...OUTPUT_RADII.map((radius) => Number((radius * 100).toFixed(1))), '药材表面'];
  const rowsTemperature = [header, ...result.store.times.map((time, i) => [time, ...result.store.temperature[i], result.store.surfaceTemperature[i]])];
  const rowsMoisture = [header, ...result.store.times.map((time, i) => [time, ...result.store.moisture[i], result.store.surfaceMoisture[i]])];
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
    sheet.getRangeByIndexes(0, 0, rows.length, 1).format.columnWidth = 22;
    sheet.getRangeByIndexes(0, 1, 1, rows[0].length - 1).format.columnWidth = 10;
    sheet.getRangeByIndexes(0, rows[0].length - 1, 1, 1).format.columnWidth = 13;
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

function buildSubmissionWorkbook(result) {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('Sheet1');
  const header = ['时间\\到药材中心的距离', ...OUTPUT_RADII.map((radius) => Number((radius * 100).toFixed(1))), '药材表面'];
  const rows = [header, ...result.store.times.map((time, i) => [time, ...result.store.moisture[i], result.store.surfaceMoisture[i]])];
  sheet.showGridLines = false;
  sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).values = rows;
  sheet.getRangeByIndexes(0, 0, 1, rows[0].length).format = { fill: '#1F4E78', font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true };
  sheet.getRangeByIndexes(1, 0, rows.length - 1, 1).format.numberFormat = '0.000';
  sheet.getRangeByIndexes(1, 1, rows.length - 1, rows[0].length - 1).format.numberFormat = '0.0000';
  sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).format.verticalAlignment = 'center';
  sheet.getRangeByIndexes(0, 0, rows.length, 1).format.columnWidth = 24;
  sheet.getRangeByIndexes(0, 1, 1, rows[0].length - 1).format.columnWidth = 10;
  sheet.getRangeByIndexes(0, rows[0].length - 1, 1, 1).format.columnWidth = 13;
  sheet.freezePanes.freezeRows(1);
  sheet.freezePanes.freezeColumns(1);
  workbook.recalculate();
  return workbook;
}

function caseConfig(caseName) {
  const configs = {
    t00: { physics: 'q3', kind: 'material', radiusMode: 'fixed' },
    t10: { physics: 'q4', kind: 'material', radiusMode: 'fixed' },
    t01: { physics: 'q3', kind: 'material', radiusMode: 'moving' },
    t11: { physics: 'q4', kind: 'material', radiusMode: 'moving' },
  };
  if (!configs[caseName]) throw new Error(`未知第四问对照: ${caseName}`);
  return configs[caseName];
}

function parseArgs(argv) {
  const args = { mode: 'full', extension: 'lastWindowMean', environmentWindow: 1800, radiusMethod: 'pchip', caseName: 't11', fourCases: false };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, rawValue] = arg.slice(2).split('=', 2);
    const value = rawValue ?? 'true';
    if (key === 'mode') args.mode = value;
    else if (key === 'n') args.n = Number(value);
    else if (key === 'dt') args.dt = Number(value);
    else if (key === 't-end') args.tEnd = Number(value);
    else if (key === 'output-interval') args.outputInterval = Number(value);
    else if (key === 'mesh') args.mesh = value;
    else if (key === 'residual-tolerance') args.residualTolerance = Number(value);
    else if (key === 'extension') args.extension = value;
    else if (key === 'environment-window') args.environmentWindow = Number(value);
    else if (key === 'radius-method') args.radiusMethod = value;
    else if (key === 'case') args.caseName = value;
    else if (key === 'comparison-file') args.comparisonFile = value;
    else if (key === 'four-cases') args.fourCases = true;
    else if (key === 'run-id') args.runId = value;
    else if (key === 'output-root') args.outputRoot = value;
    else if (key === 'no-xlsx') args.noXlsx = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!['full', 'rough', 'tests'].includes(args.mode)) throw new Error(`未知运行模式: ${args.mode}`);
  if (!['lastValue', 'lastWindowMean'].includes(args.extension)) throw new Error(`未知环境延拓: ${args.extension}`);
  if (!(args.environmentWindow > 0) || !Number.isFinite(args.environmentWindow)) throw new Error(`环境平均窗口非法: ${args.environmentWindow}`);
  if (!['linear', 'pchip', 'weibull'].includes(args.radiusMethod)) throw new Error(`未知半径方法: ${args.radiusMethod}`);
  if (args.mode === 'rough') { args.n = args.n ?? 40; args.dt = args.dt ?? 10; }
  else { args.n = args.n ?? 160; args.dt = args.dt ?? 1; }
  args.tEnd = args.tEnd ?? DEFAULT_MAX_T;
  args.outputInterval = args.outputInterval ?? 60;
  args.mesh = args.mesh ?? 'surfaceRefined';
  if (args.mesh !== 'uniform' && args.mesh !== 'surfaceRefined') throw new Error(`未知网格类型: ${args.mesh}`);
  caseConfig(args.caseName);
  return args;
}

async function createRunDirectory(options) {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const runId = options.runId ?? `q4_${options.caseName}_${options.extension}_${stamp}`;
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

async function writeArtifacts(runDir, environment, radiusModel, result, comparison, tests, options, elapsedMs) {
  const output = {
    run: { mode: options.mode, extension: options.extension, caseName: options.caseName, elapsedMs, projectRoot, radiusInputPath },
    parameters: { R0, H_T, H_M, T0, C0, threshold: THRESHOLD_C, n: result.grid.n, dt: result.requestedDt, coordinate: result.kind, mesh: result.grid.mesh, physics: result.physics, outputInterval: result.outputInterval },
    radius: { points: radiusModel.points, lastTime: radiusModel.lastTime, terminalRadius: radiusModel.radius(result.balance.finalTime), method: radiusModel.method, residuals: radiusModel.residuals, intervalViolations: radiusModel.intervalViolations },
    environment: { temperature: environment.temperaturePoints, moisture: environment.moisturePoints, extension: environment.extension, windowSeconds: environment.windowSeconds, windowStart: environment.windowStart, windowMethod: environment.windowMethod, windowPointCount: environment.windowPointCount, endpoint: environment.endpoint, lastHourMean: environment.lastHourMean, lastWindowMean: environment.lastWindowMean },
    times: result.store.times,
    physical_radii_m: OUTPUT_RADII,
    temperature_C: result.store.temperature,
    moisture_kg_per_kg: result.store.moisture,
    surface_temperature_C: result.store.surfaceTemperature,
    surface_moisture_kg_per_kg: result.store.surfaceMoisture,
    radius_m: result.store.radius,
    mean_moisture_kg_per_kg: result.store.meanMoisture,
    maximum_moisture_kg_per_kg: result.store.maximumMoisture,
    maximum_moisture_index: result.store.maximumMoistureIndex,
    stageCrossings_s: result.stageCrossings,
    slopeWindows_kg_per_kg_per_s: result.slopeWindows,
    balance: result.balance,
    status: result.thresholdEvent ? 'threshold_reached' : 'budget_not_reached',
    endpoint_state: result.endpointState ? { time: result.endpointState.time, radius: result.endpointState.radius } : null,
    last_state: { time: result.lastState.time, radius: result.lastState.radius },
    state_files: { final: 'final_state.json', checkpoints: 'state_checkpoints.json' },
    comparison,
    tests,
  };
  await fs.writeFile(path.join(runDir, 'result4_internal.json'), JSON.stringify(output, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'final_state.json'), JSON.stringify({ time: result.lastState.time, radius: result.lastState.radius, thresholdEvent: result.thresholdEvent, temperature_C: result.lastState.temperature, moisture_kg_per_kg: result.lastState.moisture, coordinates: result.grid.coordinates, weights: result.grid.weights, edgeWidths: result.grid.edgeWidths }, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'state_checkpoints.json'), JSON.stringify({ coordinates: result.grid.coordinates, weights: result.grid.weights, edgeWidths: result.grid.edgeWidths, checkpoints: result.stateCheckpoints }, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'tables_6.md'), table6(result), 'utf8');
  await fs.writeFile(path.join(runDir, 'comparison_4cases.json'), JSON.stringify(comparison, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'comparison_4cases.md'), comparisonMarkdown(comparison), 'utf8');
  await fs.writeFile(path.join(runDir, 'radius_time.csv'), csv([['time_s', 'radius_m'], ...result.store.times.map((time, i) => [time, result.store.radius[i]])]), 'utf8');
  await fs.writeFile(path.join(runDir, 'validation_q4.md'), [
    '# A题第四问验证记录', '',
    `- 模式：${options.mode}；对照：${options.caseName}；环境延拓：${options.extension}；窗口=${options.environmentWindow} s；半径方法=${radiusModel.method}；坐标=${result.kind}；物性=${result.physics}。`,
    `- N=${result.grid.n}；网格=${result.grid.mesh}；请求步长=${result.requestedDt} s；输出间隔=${result.outputInterval} s；实际终点=${result.balance.finalTime} s；接受步=${result.balance.acceptedSteps}；回退步=${result.balance.rejectedSteps}。`,
    `- 半径输入：${radiusModel.points.length}个点；原始范围${radiusModel.points[0][0]}—${radiusModel.lastTime} s；方法=${radiusModel.method}；区间外保持末观测值。`,
    `- 终点事件：${result.balance.thresholdEvent ? JSON.stringify(result.balance.thresholdEvent) : '预算内未发生；不得解释为已达标'}。`,
    `- 终点半径：${result.finalRadius * 100} cm；阶段穿越：${JSON.stringify(result.stageCrossings)}。`,
    `- 水分收支差：${result.balance.moistureBalanceError}（相对${result.balance.moistureBalanceErrorRelative}）；热收支差：${result.balance.thermalStorageBalanceError}（相对${result.balance.thermalStorageBalanceErrorRelative}）；Picard最大轮数：${result.balance.maxPicardIterations}；最大尺度残差=${result.balance.maxPicardTemperatureResidual}/${result.balance.maxPicardMoistureResidual}。`,
    `- 守护测试：${JSON.stringify(tests)}。`,
    `- 四组对照：${JSON.stringify(comparison)}。`,
    '- 正式模型在固定材料坐标x上推进，输出再按x=r/R(t)插值到物理半径；域外单元留空。',
    '- 物性与几何效应按四组反事实轨迹的对称分摊报告，不把交互项重复相加。',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(runDir, 'run_manifest.json'), JSON.stringify({
    runId: path.basename(runDir), createdAt: new Date().toISOString(), options,
    outputs: ['result4_internal.json', 'final_state.json', 'state_checkpoints.json', 'tables_6.md', 'comparison_4cases.json', 'comparison_4cases.md', 'radius_time.csv', 'validation_q4.md', ...(options.noXlsx ? [] : ['result4.xlsx', 'result4_submission.xlsx'])],
  }, null, 2), 'utf8');
  if (!options.noXlsx) {
    const workbook = buildWorkbook(result, `A题第四问 ${options.caseName} ${options.extension} W${options.environmentWindow}s ${result.radiusModel?.method ?? options.radiusMethod}`, comparison);
    const preview = await workbook.render({ sheetName: '终点摘要', range: 'A1:D10', scale: 2, format: 'png' });
    await fs.writeFile(path.join(runDir, 'preview_summary.png'), new Uint8Array(await preview.arrayBuffer()));
    const xlsx = await SpreadsheetFile.exportXlsx(workbook);
    await xlsx.save(path.join(runDir, 'result4.xlsx'));
    const submission = buildSubmissionWorkbook(result);
    const submissionXlsx = await SpreadsheetFile.exportXlsx(submission);
    await submissionXlsx.save(path.join(runDir, 'result4_submission.xlsx'));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { runId, runDir, outputRoot } = await createRunDirectory(options);
  const started = Date.now();
  const environment = await loadRefinedEnvironment(options.extension, options.environmentWindow);
  const radiusModel = await loadRadiusModel(options.radiusMethod);
  const tests = runTests();
  if (options.mode === 'tests') {
    const testConfig = caseConfig(options.caseName);
    const testRadiusModel = testConfig.radiusMode === 'fixed' ? constantRadiusModel(R0) : radiusModel;
    const testResult = simulateQuestion4(environment, testRadiusModel, { n: 16, dt: 0.5, tEnd: 5, outputInterval: 5, ...testConfig });
    const comparison = { status: 'tests only', times_h: { t00: null, t10: null, t01: null, t11: null }, event_bracket_width_h: {}, interaction_h: null, property_effect_h: null, geometry_effect_h: null, decomposition_check_h: null };
    await writeArtifacts(runDir, environment, testRadiusModel, testResult, comparison, tests, options, Date.now() - started);
    console.log(JSON.stringify({ runId, runDir, outputRoot, tests }, null, 2));
    return;
  }
  const configs = options.fourCases ? ['t00', 't10', 't01', 't11'] : [options.caseName];
  const cases = {};
  for (const caseName of configs) {
    const config = caseConfig(caseName);
    const selectedRadiusModel = config.radiusMode === 'fixed' ? constantRadiusModel(R0) : radiusModel;
    cases[caseName] = simulateQuestion4(environment, selectedRadiusModel, { ...options, ...config, caseName });
  }
  const result = cases[options.caseName] ?? cases.t11;
  const resultConfig = caseConfig(options.caseName);
  const resultRadiusModel = resultConfig.radiusMode === 'fixed' ? constantRadiusModel(R0) : radiusModel;
  const singleTimes = { t00: null, t10: null, t01: null, t11: null };
  singleTimes[options.caseName] = result.thresholdEvent ? result.thresholdEvent.confirmedTime / 3600 : null;
  const comparison = options.comparisonFile
    ? JSON.parse(await fs.readFile(path.resolve(projectRoot, options.comparisonFile), 'utf8'))
    : options.fourCases
      ? compareCases(cases)
      : { status: result.thresholdEvent ? 'single case complete' : 'single case did not reach threshold within the budget', times_h: singleTimes, event_bracket_width_h: { [options.caseName]: result.thresholdEvent ? (result.thresholdEvent.bracket[1] - result.thresholdEvent.bracket[0]) / 3600 : null }, interaction_h: null, property_effect_h: null, geometry_effect_h: null, decomposition_check_h: null };
  await writeArtifacts(runDir, environment, resultRadiusModel, result, comparison, tests, options, Date.now() - started);
  console.log(JSON.stringify({ runId, runDir, outputRoot, finalTime: result.balance.finalTime, thresholdEvent: result.balance.thresholdEvent, comparison, tests }, null, 2));
}

export {
  R0,
  H_T,
  H_M,
  T0,
  C0,
  gridForCoordinate,
  coupledStepQ4,
  makeRadiusModel,
  loadRadiusModel,
  simulateQuestion4,
  manufacturedFields,
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
