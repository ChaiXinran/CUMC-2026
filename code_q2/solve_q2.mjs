import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const R = 0.02;
const H_T = 25;
const H_M = 8e-7;
const T0 = 28;
const C0 = 2.55;
const D_PREFACTOR = 2.4e-3;
const T_REF_K = 301.15;
const D0 = D_PREFACTOR * Math.exp(-0.45 / C0 - 3850 / T_REF_K);
const OUTPUT_RADII = Array.from({ length: 21 }, (_, i) => Number((i * 0.001).toFixed(3)));
const REPORT_TIMES = [1800, 3600, 5400, 7200, 9000, 10800];
const THRESHOLD_C = 0.15;
const DEFAULT_MAX_T = 72 * 3600;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = path.join(projectRoot, 'CUMCM2026Problems/A题/附件/附件1.xlsx');
const q2OutputRoot = path.join(projectRoot, 'outputs/q2');

function maxAbs(values) {
  let result = 0;
  for (const value of values) result = Math.max(result, Math.abs(value));
  return result;
}

function maxAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error('比较数组长度不一致');
  let result = 0;
  for (let i = 0; i < a.length; i++) result = Math.max(result, Math.abs(a[i] - b[i]));
  return result;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function linInterp(points, t) {
  if (t <= points[0][0]) return points[0][1];
  if (t >= points[points.length - 1][0]) return points[points.length - 1][1];
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, y0] = points[lo];
  const [t1, y1] = points[hi];
  return y0 + ((t - t0) / (t1 - t0)) * (y1 - y0);
}

function gridFor(n) {
  if (!Number.isInteger(n) || n < 2) throw new Error(`径向区间数必须至少为 2: ${n}`);
  const dr = R / n;
  const radii = Array.from({ length: n + 1 }, (_, i) => i * dr);
  const weights = new Array(n + 1);
  const faces = new Array(n);
  for (let i = 0; i <= n; i++) {
    const rm = i === 0 ? 0 : (i - 0.5) * dr;
    const rp = i === n ? R : (i + 0.5) * dr;
    weights[i] = 0.5 * (rp * rp - rm * rm);
  }
  for (let i = 0; i < n; i++) faces[i] = (i + 0.5) * dr;
  return { n, dr, radii, weights, faces };
}

function interpolateState(radii, state, radius) {
  if (radius <= radii[0]) return state[0];
  if (radius >= radii[radii.length - 1]) return state[state.length - 1];
  const position = radius / (radii[1] - radii[0]);
  const i = Math.min(radii.length - 2, Math.floor(position));
  const w = position - i;
  return state[i] * (1 - w) + state[i + 1] * w;
}

function sampleState(grid, state) {
  return OUTPUT_RADII.map((radius) => interpolateState(grid.radii, state, radius));
}

function weightedAverage(grid, state) {
  let total = 0;
  for (let i = 0; i <= grid.n; i++) total += grid.weights[i] * state[i];
  return (2 / (R * R)) * total;
}

function sumWeighted(grid, state) {
  let total = 0;
  for (let i = 0; i <= grid.n; i++) total += grid.weights[i] * state[i];
  return total;
}

function validateState(temperature, moisture, label) {
  for (let i = 0; i < temperature.length; i++) {
    if (!Number.isFinite(temperature[i]) || temperature[i] + 273.15 <= 0) {
      throw new Error(`${label} 温度非有限或绝对温度非正: index=${i}, value=${temperature[i]}`);
    }
    if (!Number.isFinite(moisture[i]) || moisture[i] <= 0) {
      throw new Error(`${label} 含水率非正或非有限: index=${i}, value=${moisture[i]}`);
    }
  }
}

function rho(c) {
  if (!(c > 0) || !Number.isFinite(c)) throw new Error(`rho 输入非法: ${c}`);
  return 650 + 128 * c;
}

function cp(c) {
  if (!(c > 0) || !Number.isFinite(c)) throw new Error(`cp 输入非法: ${c}`);
  return 1450 + 2736 * c / (1 + c);
}

function heatCapacity(c) {
  return rho(c) * cp(c);
}

function conductivity(c) {
  if (!(c > 0) || !Number.isFinite(c)) throw new Error(`k 输入非法: ${c}`);
  return 0.21 + 0.38 * c / (1 + c);
}

function diffusionCoefficient(c, temperatureC, mode = { a: 1, b: 1 }) {
  if (!(c > 0) || !Number.isFinite(c)) throw new Error(`D 输入含水率非法: ${c}`);
  const temperatureK = temperatureC + 273.15;
  if (!(temperatureK > 0) || !Number.isFinite(temperatureK)) throw new Error(`D 输入绝对温度非法: ${temperatureK}`);
  const aT = 3850 * (1 / T_REF_K - 1 / temperatureK);
  const aC = 0.45 * (1 / C0 - 1 / c);
  const value = D0 * Math.exp(mode.a * aT + mode.b * aC);
  if (!(value > 0) || !Number.isFinite(value)) throw new Error(`D 结果非法: ${value}`);
  return value;
}

function initialDiffusion() {
  return D0;
}

function harmonicMean(a, b) {
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`调和平均输入非法: ${a}, ${b}`);
  }
  return (2 * a * b) / (a + b);
}

function nodeToFaceCoefficient(nodeValues) {
  return nodeValues.slice(0, -1).map((value, i) => harmonicMean(value, nodeValues[i + 1]));
}

function solveTridiagonal(lower, diagonal, upper, rhs) {
  const n = diagonal.length;
  const a = lower.slice();
  const b = diagonal.slice();
  const c = upper.slice();
  const d = rhs.slice();
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(b[i]) || Math.abs(b[i]) < 1e-30 || !Number.isFinite(d[i])) {
      throw new Error(`三对角系统主元或右端非法: index=${i}, diagonal=${b[i]}, rhs=${d[i]}`);
    }
  }
  for (let i = 1; i < n; i++) {
    const factor = a[i] / b[i - 1];
    b[i] -= factor * c[i - 1];
    d[i] -= factor * d[i - 1];
    if (!Number.isFinite(b[i]) || Math.abs(b[i]) < 1e-30 || !Number.isFinite(d[i])) {
      throw new Error(`三对角消元失败: index=${i}, diagonal=${b[i]}, rhs=${d[i]}`);
    }
  }
  const x = new Array(n);
  x[n - 1] = d[n - 1] / b[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = (d[i] - c[i] * x[i + 1]) / b[i];
  if (x.some((value) => !Number.isFinite(value))) throw new Error('三对角系统解包含非有限值');
  return x;
}

function assembleLinearSystem(grid, oldState, dt, capacity, faceCoefficient, exchangeCoefficient, environment, source = null) {
  const size = grid.n + 1;
  const lower = new Array(size).fill(0);
  const diagonal = new Array(size).fill(0);
  const upper = new Array(size).fill(0);
  const rhs = new Array(size);
  for (let i = 0; i <= grid.n; i++) {
    const capacityI = Array.isArray(capacity) ? capacity[i] : capacity;
    if (!(capacityI > 0) || !Number.isFinite(capacityI)) throw new Error(`积累系数非法: ${capacityI}`);
    const storage = capacityI * grid.weights[i] / dt;
    const left = i === 0 ? 0 : grid.faces[i - 1] * faceCoefficient[i - 1] / grid.dr;
    const right = i === grid.n
      ? R * exchangeCoefficient
      : grid.faces[i] * faceCoefficient[i] / grid.dr;
    diagonal[i] = storage + left + right;
    rhs[i] = storage * oldState[i] + (source ? source[i] * grid.weights[i] : 0);
    if (i > 0) lower[i] = -left;
    if (i < grid.n) upper[i] = -right;
    if (i === grid.n) rhs[i] += R * exchangeCoefficient * environment;
  }
  return { lower, diagonal, upper, rhs };
}

function solveLinearStep(grid, oldState, dt, capacity, faceCoefficient, exchangeCoefficient, environment, source = null) {
  const system = assembleLinearSystem(
    grid,
    oldState,
    dt,
    capacity,
    faceCoefficient,
    exchangeCoefficient,
    environment,
    source,
  );
  return solveTridiagonal(system.lower, system.diagonal, system.upper, system.rhs);
}

function fieldResidual(grid, oldState, newState, dt, capacity, faceCoefficient, exchangeCoefficient, environment, source = null) {
  let maxScaled = 0;
  let maxAbsolute = 0;
  let maxRelative = 0;
  for (let i = 0; i <= grid.n; i++) {
    const capacityI = Array.isArray(capacity) ? capacity[i] : capacity;
    const leftFlux = i === 0
      ? 0
      : -grid.faces[i - 1] * faceCoefficient[i - 1] * (newState[i] - newState[i - 1]) / grid.dr;
    const rightFlux = i === grid.n
      ? R * exchangeCoefficient * (newState[i] - environment)
      : -grid.faces[i] * faceCoefficient[i] * (newState[i + 1] - newState[i]) / grid.dr;
    const sourceI = source ? source[i] : 0;
    const lhs = grid.weights[i] * capacityI * (newState[i] - oldState[i]) / dt;
    const residual = lhs - leftFlux + rightFlux - grid.weights[i] * sourceI;
    const scaled = Math.abs(residual) * dt / Math.max(1e-30, grid.weights[i] * capacityI);
    const denominator = Math.max(Math.abs(lhs), Math.abs(leftFlux), Math.abs(rightFlux), Math.abs(grid.weights[i] * sourceI), 1e-30);
    maxScaled = Math.max(maxScaled, scaled);
    maxAbsolute = Math.max(maxAbsolute, Math.abs(residual));
    maxRelative = Math.max(maxRelative, Math.abs(residual) / denominator);
  }
  return { scaled: maxScaled, absolute: maxAbsolute, relative: maxRelative };
}

function coupledStep(grid, oldTemperature, oldMoisture, dt, environment, options = {}) {
  const mode = options.diffusionMode ?? { a: 1, b: 1 };
  const maxIterations = options.maxIterations ?? 100;
  const temperatureUpdateTolerance = options.temperatureUpdateTolerance ?? 1e-8;
  const moistureUpdateTolerance = options.moistureUpdateTolerance ?? 1e-10;
  const residualTolerance = options.residualTolerance ?? 1e-8;
  const relaxation = options.relaxation ?? 0.8;
  let guessTemperature = oldTemperature.slice();
  let guessMoisture = oldMoisture.slice();
  let lastTemperatureResidual = { scaled: Infinity, absolute: Infinity, relative: Infinity };
  let lastMoistureResidual = { scaled: Infinity, absolute: Infinity, relative: Infinity };
  let lastTemperatureUpdate = Infinity;
  let lastMoistureUpdate = Infinity;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const nodeCapacity = guessMoisture.map(heatCapacity);
    const nodeK = guessMoisture.map(conductivity);
    const faceK = nodeToFaceCoefficient(nodeK);
    const temperatureSource = options.temperatureSource ? options.temperatureSource(grid, environment.time) : null;
    const rawTemperature = solveLinearStep(
      grid,
      oldTemperature,
      dt,
      nodeCapacity,
      faceK,
      options.heatExchangeCoefficient ?? H_T,
      environment.temperature,
      temperatureSource,
    );
    const rawMoistureCoefficient = guessMoisture.map((c, i) => diffusionCoefficient(c, rawTemperature[i], mode));
    const faceD = nodeToFaceCoefficient(rawMoistureCoefficient);
    const moistureSource = options.moistureSource ? options.moistureSource(grid, environment.time) : null;
    const rawMoisture = solveLinearStep(
      grid,
      oldMoisture,
      dt,
      1,
      faceD,
      options.moistureExchangeCoefficient ?? H_M,
      environment.moisture,
      moistureSource,
    );
    const nextTemperature = guessTemperature.map((value, i) => value + relaxation * (rawTemperature[i] - value));
    const nextMoisture = guessMoisture.map((value, i) => value + relaxation * (rawMoisture[i] - value));
    validateState(nextTemperature, nextMoisture, `Picard iteration ${iteration}`);
    const finalCapacity = nextMoisture.map(heatCapacity);
    const finalK = nodeToFaceCoefficient(nextMoisture.map(conductivity));
    const finalD = nodeToFaceCoefficient(nextMoisture.map((c, i) => diffusionCoefficient(c, nextTemperature[i], mode)));
    lastTemperatureUpdate = maxAbsDiff(nextTemperature, guessTemperature);
    lastMoistureUpdate = maxAbsDiff(nextMoisture, guessMoisture);
    lastTemperatureResidual = fieldResidual(
      grid,
      oldTemperature,
      nextTemperature,
      dt,
      finalCapacity,
      finalK,
      options.heatExchangeCoefficient ?? H_T,
      environment.temperature,
      temperatureSource,
    );
    lastMoistureResidual = fieldResidual(
      grid,
      oldMoisture,
      nextMoisture,
      dt,
      1,
      finalD,
      options.moistureExchangeCoefficient ?? H_M,
      environment.moisture,
      moistureSource,
    );
    guessTemperature = nextTemperature;
    guessMoisture = nextMoisture;
    if (
      lastTemperatureUpdate <= temperatureUpdateTolerance
      && lastMoistureUpdate <= moistureUpdateTolerance
      && lastTemperatureResidual.scaled <= residualTolerance
      && lastMoistureResidual.scaled <= residualTolerance
    ) {
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
  throw new Error(
    `双场 Picard 未收敛: T_update=${lastTemperatureUpdate}, C_update=${lastMoistureUpdate}, `
    + `T_residual=${lastTemperatureResidual.scaled}, C_residual=${lastMoistureResidual.scaled}`,
  );
}

function makeEnvironment(rows, extension = 'lastValue') {
  const cleanRows = rows
    .map((row) => [Number(row[0]), Number(row[1]), Number(row[2])])
    .filter((row) => row.every((value) => Number.isFinite(value)))
    .sort((a, b) => a[0] - b[0]);
  if (cleanRows.length < 2) throw new Error('附件 1 有效环境数据不足');
  for (let i = 1; i < cleanRows.length; i++) {
    if (!(cleanRows[i][0] > cleanRows[i - 1][0])) throw new Error('附件 1 时间点不严格递增');
  }
  const temperaturePoints = cleanRows.map((row) => [row[0], row[1]]);
  const moisturePoints = cleanRows.map((row) => [row[0], row[2]]);
  const lastTime = cleanRows[cleanRows.length - 1][0];
  const meanStart = Math.max(0, lastTime - 3600);
  const meanRows = cleanRows.filter((row) => row[0] >= meanStart);
  const meanTemperature = sum(meanRows.map((row) => row[1])) / meanRows.length;
  const meanMoisture = sum(meanRows.map((row) => row[2])) / meanRows.length;
  const endpoint = cleanRows[cleanRows.length - 1];
  const environment = {
    extension,
    lastTime,
    temperaturePoints,
    moisturePoints,
    endpoint: { temperature: endpoint[1], moisture: endpoint[2] },
    lastHourMean: { temperature: meanTemperature, moisture: meanMoisture },
    temperature: (t) => {
      if (t <= lastTime) return linInterp(temperaturePoints, t);
      return extension === 'lastHourMean' ? meanTemperature : endpoint[1];
    },
    moisture: (t) => {
      if (t <= lastTime) return linInterp(moisturePoints, t);
      return extension === 'lastHourMean' ? meanMoisture : endpoint[2];
    },
  };
  return environment;
}

async function loadEnvironment(extension = 'lastValue') {
  const input = await FileBlob.load(inputPath);
  const workbook = await SpreadsheetFile.importXlsx(input);
  const sheet = workbook.worksheets.getItemAt(0);
  const values = sheet.getUsedRange(true).values;
  const rows = values.slice(1).filter((row) => row[0] !== null && row[0] !== undefined);
  const environment = makeEnvironment(rows, extension);
  if (environment.temperaturePoints.length !== 241) {
    throw new Error(`附件 1 环境点数量不是 241: ${environment.temperaturePoints.length}`);
  }
  return environment;
}

function emptyRecordStore() {
  return {
    times: [],
    temperature: [],
    moisture: [],
    meanTemperature: [],
    meanMoisture: [],
    surfaceTemperature: [],
    surfaceMoisture: [],
  };
}

function storeRecord(store, time, grid, temperature, moisture) {
  store.times.push(time);
  store.temperature.push(sampleState(grid, temperature));
  store.moisture.push(sampleState(grid, moisture));
  store.meanTemperature.push(weightedAverage(grid, temperature));
  store.meanMoisture.push(weightedAverage(grid, moisture));
  store.surfaceTemperature.push(temperature[grid.n]);
  store.surfaceMoisture.push(moisture[grid.n]);
}

function defaultStoreTimes(tEnd) {
  return Array.from({ length: Math.floor(tEnd) + 1 }, (_, i) => i);
}

function exactTime(value, tolerance = 1e-8) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) <= tolerance ? rounded : value;
}

function modeConfig(mode) {
  if (mode === '3h') return { tEnd: 10800, n: 320, dt: 0.125, stopAtThreshold: false };
  if (mode === 'full') return { tEnd: DEFAULT_MAX_T, n: 320, dt: 0.125, stopAtThreshold: true };
  return { tEnd: 100, n: 80, dt: 0.25, stopAtThreshold: false };
}

function parseArgs(argv) {
  const args = { mode: 'short', extension: 'lastValue', diffusionCase: 'M11' };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, rawValue] = arg.slice(2).split('=', 2);
    const value = rawValue ?? 'true';
    if (key === 'mode') args.mode = value;
    else if (key === 'n') args.n = Number(value);
    else if (key === 'dt') args.dt = Number(value);
    else if (key === 't-end') args.tEnd = Number(value);
    else if (key === 'extension') args.extension = value;
    else if (key === 'case') args.diffusionCase = value;
    else if (key === 'run-id') args.runId = value;
    else if (key === 'output-root') args.outputRoot = value;
    else if (key === 'no-xlsx') args.noXlsx = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!['short', '3h', 'full', 'tests'].includes(args.mode)) throw new Error(`未知运行模式: ${args.mode}`);
  if (!['lastValue', 'lastHourMean'].includes(args.extension)) throw new Error(`未知环境延拓: ${args.extension}`);
  if (!['M00', 'M10', 'M01', 'M11'].includes(args.diffusionCase)) throw new Error(`未知扩散对照: ${args.diffusionCase}`);
  return args;
}

function diffusionMode(caseName) {
  return { a: Number(caseName[1]), b: Number(caseName[2]) };
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

function manufacturedFields(time, radius) {
  const x = radius / R;
  const et = Math.exp(-time / 600);
  const ec = Math.exp(-time / 900);
  const temperature = 28 + 2 * et * (1 + x * x);
  const moisture = 1 + 0.2 * ec * (1 + 0.5 * x * x);
  const temperatureT = -(2 / 600) * et * (1 + x * x);
  const temperatureR = 4 * et * radius / (R * R);
  const temperatureRR = 4 * et / (R * R);
  const moistureT = -(0.2 / 900) * ec * (1 + 0.5 * x * x);
  const moistureR = 0.2 * ec * radius / (R * R);
  const moistureRR = 0.2 * ec / (R * R);
  const c = moisture;
  const k = conductivity(c);
  const d = diffusionCoefficient(c, temperature, { a: 1, b: 1 });
  const dkdc = 0.38 / ((1 + c) * (1 + c));
  const dDdc = 0.45 * d / (c * c);
  const dDdT = 3850 * d / ((temperature + 273.15) * (temperature + 273.15));
  const radialTemperatureLaplacian = radius === 0
    ? 8 * et / (R * R)
    : temperatureRR + temperatureR / radius;
  const radialMoistureLaplacian = radius === 0
    ? 0.4 * ec / (R * R)
    : moistureRR + moistureR / radius;
  const divTemperature = k * radialTemperatureLaplacian + dkdc * moistureR * temperatureR;
  const divMoisture = d * radialMoistureLaplacian + dDdc * moistureR * moistureR + dDdT * temperatureR * moistureR;
  return {
    temperature,
    moisture,
    temperatureR,
    moistureR,
    temperatureSource: heatCapacity(c) * temperatureT - divTemperature,
    moistureSource: moistureT - divMoisture,
  };
}

function manufacturedEnvironment(time) {
  const surface = manufacturedFields(time, R);
  return {
    time,
    temperature: surface.temperature + conductivity(surface.moisture) * surface.temperatureR / H_T,
    moisture: surface.moisture + diffusionCoefficient(surface.moisture, surface.temperature, { a: 1, b: 1 }) * surface.moistureR / H_M,
  };
}

function manufacturedSource(field, time) {
  return (grid) => grid.radii.map((radius) => manufacturedFields(time, radius)[field]);
}

function simulateQuestion2(environment, options = {}) {
  const n = options.n ?? 80;
  const requestedDt = options.dt ?? 0.25;
  const tEnd = options.tEnd ?? 100;
  const requestedTimes = options.storeTimes ?? defaultStoreTimes(tEnd);
  const grid = gridFor(n);
  let temperature = options.initialTemperature
    ? options.initialTemperature.slice()
    : new Array(n + 1).fill(T0);
  let moisture = options.initialMoisture
    ? options.initialMoisture.slice()
    : new Array(n + 1).fill(C0);
  validateState(temperature, moisture, '初始状态');
  const store = emptyRecordStore();
  const balance = {
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
  let t = 0;
  let dt = requestedDt;
  let storeIndex = 0;
  if (requestedTimes.length > 0 && Math.abs(requestedTimes[0]) < 1e-8) {
    storeRecord(store, 0, grid, temperature, moisture);
    storeIndex = 1;
  }
  let previousMaximumMoisture = Math.max(...moisture);
  let thresholdEvent = null;
  while (t < tEnd - 1e-10) {
    const target = requestedTimes[storeIndex] ?? tEnd;
    const dtStep = Math.min(dt, target - t, tEnd - t);
    if (!(dtStep > 0)) {
      if (Math.abs(target - t) < 1e-8) {
        storeIndex++;
        continue;
      }
      throw new Error(`时间推进目标异常: t=${t}, target=${target}, dt=${dt}`);
    }
    const nextTime = t + dtStep;
    const oldTemperature = temperature;
    const oldMoisture = moisture;
    const oldMaximumMoisture = previousMaximumMoisture;
    try {
      const envAtStep = {
        time: nextTime,
        temperature: options.manufactured ? manufacturedEnvironment(nextTime).temperature : environment.temperature(nextTime),
        moisture: options.manufactured ? manufacturedEnvironment(nextTime).moisture : environment.moisture(nextTime),
      };
      const step = coupledStep(grid, oldTemperature, oldMoisture, dtStep, envAtStep, {
        diffusionMode: options.diffusionMode,
        relaxation: options.relaxation,
        maxIterations: options.maxIterations,
        temperatureUpdateTolerance: options.temperatureUpdateTolerance,
        moistureUpdateTolerance: options.moistureUpdateTolerance,
        residualTolerance: options.residualTolerance,
        heatExchangeCoefficient: options.heatExchangeCoefficient,
        moistureExchangeCoefficient: options.moistureExchangeCoefficient,
        temperatureSource: options.manufactured ? manufacturedSource('temperatureSource', nextTime) : null,
        moistureSource: options.manufactured ? manufacturedSource('moistureSource', nextTime) : null,
      });
      temperature = step.temperature;
      moisture = step.moisture;
      t = nextTime;
      const maximumMoisture = Math.max(...moisture);
      const boundaryMoistureOutflow = dtStep * R * (options.moistureExchangeCoefficient ?? H_M) * (moisture[grid.n] - envAtStep.moisture);
      const boundaryHeatOutflow = dtStep * R * (options.heatExchangeCoefficient ?? H_T) * (temperature[grid.n] - envAtStep.temperature);
      const thermalStorageChange = sumWeighted(grid, moisture.map((c, i) => heatCapacity(c) * (temperature[i] - oldTemperature[i])));
      balance.cumulativeBoundaryMoistureOutflow += boundaryMoistureOutflow;
      balance.cumulativeBoundaryHeatOutflow += boundaryHeatOutflow;
      balance.cumulativeThermalStorageChange += thermalStorageChange;
      balance.maxPicardIterations = Math.max(balance.maxPicardIterations, step.iterations);
      balance.maxPicardTemperatureUpdate = Math.max(balance.maxPicardTemperatureUpdate, step.temperatureUpdate);
      balance.maxPicardMoistureUpdate = Math.max(balance.maxPicardMoistureUpdate, step.moistureUpdate);
      balance.maxPicardTemperatureResidual = Math.max(balance.maxPicardTemperatureResidual, step.temperatureResidual.scaled);
      balance.maxPicardMoistureResidual = Math.max(balance.maxPicardMoistureResidual, step.moistureResidual.scaled);
      balance.acceptedSteps++;
      balance.minTemperature = Math.min(balance.minTemperature, ...temperature);
      balance.maxTemperature = Math.max(balance.maxTemperature, ...temperature);
      balance.minMoisture = Math.min(balance.minMoisture, ...moisture);
      balance.maxMoisture = Math.max(balance.maxMoisture, ...moisture);
      if (!thresholdEvent && oldMaximumMoisture > THRESHOLD_C && maximumMoisture <= THRESHOLD_C) {
        const fraction = (THRESHOLD_C - oldMaximumMoisture) / (maximumMoisture - oldMaximumMoisture);
        thresholdEvent = {
          bracket: [t - dtStep, t],
          oldMaximumMoisture,
          newMaximumMoisture: maximumMoisture,
          linearEstimate: t - dtStep + Math.max(0, Math.min(1, fraction)) * dtStep,
        };
      }
      previousMaximumMoisture = maximumMoisture;
      while (storeIndex < requestedTimes.length && requestedTimes[storeIndex] <= t + 1e-8) {
        if (Math.abs(requestedTimes[storeIndex] - t) > 1e-8) {
          throw new Error(`输出时间未准确落点: requested=${requestedTimes[storeIndex]}, actual=${t}`);
        }
        storeRecord(store, exactTime(t), grid, temperature, moisture);
        storeIndex++;
      }
      if (options.stopAtThreshold && thresholdEvent) break;
    } catch (error) {
      if (dt <= requestedDt / 128) throw error;
      dt *= 0.5;
      balance.rejectedSteps++;
    }
  }
  balance.finalMoistureIntegral = sumWeighted(grid, moisture);
  balance.integralMoistureLoss = balance.initialMoistureIntegral - balance.finalMoistureIntegral;
  balance.moistureBalanceError = balance.integralMoistureLoss - balance.cumulativeBoundaryMoistureOutflow;
  balance.thermalStorageBalanceError = balance.cumulativeThermalStorageChange + balance.cumulativeBoundaryHeatOutflow;
  balance.finalTime = t;
  balance.thresholdEvent = thresholdEvent;
  return {
    grid,
    store,
    balance,
    requestedDt,
    tEnd,
    diffusionMode: options.diffusionMode ?? { a: 1, b: 1 },
    finalTemperature: temperature,
    finalMoisture: moisture,
  };
}

function runEquilibriumTest() {
  const environment = makeConstantEnvironment(T0, C0);
  const result = simulateQuestion2(environment, {
    n: 20,
    dt: 1,
    tEnd: 100,
    storeTimes: [0, 100],
    diffusionMode: { a: 1, b: 1 },
  });
  const initialT = new Array(result.grid.n + 1).fill(T0);
  const initialC = new Array(result.grid.n + 1).fill(C0);
  return {
    temperatureMaxChange: maxAbsDiff(result.finalTemperature, initialT),
    moistureMaxChange: maxAbsDiff(result.finalMoisture, initialC),
    acceptedSteps: result.balance.acceptedSteps,
  };
}

function runClosedBoundaryTest() {
  const grid = gridFor(20);
  const initialTemperature = grid.radii.map((radius) => 28 + 3 * (radius / R) ** 2);
  const initialMoisture = grid.radii.map((radius) => 1.2 + 0.4 * (radius / R) ** 2);
  const environment = makeConstantEnvironment(T0, C0);
  const initialTIntegral = sumWeighted(grid, initialTemperature);
  const initialCIntegral = sumWeighted(grid, initialMoisture);
  const result = simulateQuestion2(environment, {
    n: 20,
    dt: 1,
    tEnd: 100,
    storeTimes: [0, 100],
    initialTemperature,
    initialMoisture,
    heatExchangeCoefficient: 0,
    moistureExchangeCoefficient: 0,
    diffusionMode: { a: 1, b: 1 },
  });
  return {
    finalTemperatureMin: Math.min(...result.finalTemperature),
    finalTemperatureMax: Math.max(...result.finalTemperature),
    initialTemperatureIntegral: initialTIntegral,
    moistureRelativeIntegralError: Math.abs(sumWeighted(grid, result.finalMoisture) - initialCIntegral) / Math.max(1, Math.abs(initialCIntegral)),
    acceptedSteps: result.balance.acceptedSteps,
  };
}

function runManufacturedSolutionTest() {
  const tEnd = 30;
  const n = 20;
  const grid = gridFor(n);
  const initial = grid.radii.map((radius) => manufacturedFields(0, radius));
  const environment = makeConstantEnvironment(0, 0);
  const result = simulateQuestion2(environment, {
    n,
    dt: 0.25,
    tEnd,
    storeTimes: [0, tEnd],
    initialTemperature: initial.map((value) => value.temperature),
    initialMoisture: initial.map((value) => value.moisture),
    manufactured: true,
    diffusionMode: { a: 1, b: 1 },
  });
  const exactFinal = grid.radii.map((radius) => manufacturedFields(tEnd, radius));
  return {
    temperatureMaxError: maxAbsDiff(result.finalTemperature, exactFinal.map((value) => value.temperature)),
    moistureMaxError: maxAbsDiff(result.finalMoisture, exactFinal.map((value) => value.moisture)),
    acceptedSteps: result.balance.acceptedSteps,
  };
}

function runConstantCoefficientBesselTest() {
  const grid = gridFor(40);
  const diffusivity = initialDiffusion();
  const exchange = H_M;
  const biot = exchange * R / diffusivity;
  const besselJ0 = (x) => {
    let term = 1;
    let result = 1;
    const z = -(x * x) / 4;
    for (let m = 1; m < 100; m++) {
      term *= z / (m * m);
      result += term;
      if (Math.abs(term) < 1e-16 * Math.max(1, Math.abs(result))) break;
    }
    return result;
  };
  const besselJ1 = (x) => {
    let term = x / 2;
    let result = term;
    const z = -(x * x) / 4;
    for (let m = 1; m < 100; m++) {
      term *= z / (m * (m + 1));
      result += term;
      if (Math.abs(term) < 1e-16 * Math.max(1, Math.abs(result))) break;
    }
    return result;
  };
  const f = (mu) => mu * besselJ1(mu) - biot * besselJ0(mu);
  let left = 1e-6;
  let fLeft = f(left);
  let root = null;
  for (let right = 0.01; right <= 10; right += 0.01) {
    const fRight = f(right);
    if (fLeft * fRight <= 0) {
      let a = left;
      let b = right;
      for (let i = 0; i < 80; i++) {
        const m = 0.5 * (a + b);
        if (f(a) * f(m) <= 0) b = m;
        else a = m;
      }
      root = 0.5 * (a + b);
      break;
    }
    left = right;
    fLeft = fRight;
  }
  if (!root) throw new Error(`常系数圆柱基准未找到特征根: Bi=${biot}`);
  const amplitude = 0.1;
  const initialMoisture = grid.radii.map((radius) => C0 + amplitude * besselJ0(root * radius / R));
  const environment = makeConstantEnvironment(C0, C0);
  const tEnd = 100;
  const result = simulateQuestion2(environment, {
    n: grid.n,
    dt: 0.25,
    tEnd,
    storeTimes: [0, tEnd],
    initialTemperature: new Array(grid.n + 1).fill(T0),
    initialMoisture,
    diffusionMode: { a: 0, b: 0 },
  });
  const decay = Math.exp(-(diffusivity * root * root * tEnd) / (R * R));
  const exact = grid.radii.map((radius) => C0 + amplitude * besselJ0(root * radius / R) * decay);
  return { biot, root, maxError: maxAbsDiff(result.finalMoisture, exact) };
}

function reportTables(result) {
  const outputIndices = [0, 5, 10, 15, 20];
  const header = ['时间/s', ...outputIndices.map((i) => `${OUTPUT_RADII[i] * 100}`)];
  const separator = '|---:|' + outputIndices.map(() => '---:').join('|') + '|';
  const table = (title, records) => {
    const lines = [title, '', `| ${header.join(' | ')} |`, separator];
    for (const time of REPORT_TIMES) {
      const row = result.store.times.indexOf(time);
      if (row < 0) continue;
      lines.push(`| ${time} | ${outputIndices.map((i) => records[row][i].toFixed(4)).join(' | ')} |`);
    }
    return lines.join('\n');
  };
  return [
    '# A题第二问表3、表4（当前运行）',
    '',
    table('## 表3 温度（℃）', result.store.temperature),
    '',
    table('## 表4 水分浓度（kg/kg）', result.store.moisture),
    '',
    '表格按当前运行实际可用的时刻列出；内部结果保留完整精度，四位小数仅用于展示。',
  ].join('\n');
}

function validationReport(environment, result, tests, options, elapsedMs) {
  const b = result?.balance;
  const lines = [
    '# A题第二问验证记录',
    '',
    '## 运行状态',
    '',
    `- 工作目录：${projectRoot}`,
    `- 运行模式：${options.mode}；扩散模型：${options.diffusionCase}；环境延拓：${options.extension}。`,
    `- 网格：N=${result?.grid.n ?? '未计算'}；请求时间步：${options.dt ?? '未计算'} s；终点上限：${options.tEnd ?? '未计算'} s。`,
    `- 初始条件：T=${T0} ℃，C=${C0} kg/kg；模型从原始初值开始。`,
    `- 附件 1 环境点：${environment.temperaturePoints.length} 个，观测终点 ${environment.lastTime} s。`,
    `- 实际用时：${(elapsedMs / 1000).toFixed(3)} s。`,
    '',
    '## 关键输入核对',
    '',
    `- t=0 s：T∞=${environment.temperature(0).toFixed(6)} ℃，C∞=${environment.moisture(0).toFixed(8)} kg/kg。`,
    `- t=1800 s：T∞=${environment.temperature(1800).toFixed(6)} ℃，C∞=${environment.moisture(1800).toFixed(8)} kg/kg。`,
    `- t=3600 s：T∞=${environment.temperature(3600).toFixed(6)} ℃，C∞=${environment.moisture(3600).toFixed(8)} kg/kg。`,
    `- t=7200 s：T∞=${environment.temperature(7200).toFixed(6)} ℃，C∞=${environment.moisture(7200).toFixed(8)} kg/kg。`,
    `- t=10800 s：T∞=${environment.temperature(10800).toFixed(6)} ℃，C∞=${environment.moisture(10800).toFixed(8)} kg/kg。`,
    `- t=14400 s：T∞=${environment.temperature(14400).toFixed(6)} ℃，C∞=${environment.moisture(14400).toFixed(8)} kg/kg。`,
    `- 14400 s 后 ${options.extension} 延拓值：T∞=${environment.temperature(20000).toFixed(10)} ℃，C∞=${environment.moisture(20000).toFixed(10)} kg/kg。`,
    `- 初始物性自检：rho=${rho(C0).toFixed(10)} kg/m³，cp=${cp(C0).toFixed(10)} J/(kg·K)，k=${conductivity(C0).toFixed(10)} W/(m·K)，b=${heatCapacity(C0).toFixed(10)} J/(m³·K)，D0=${initialDiffusion().toExponential(10)} m²/s。`,
    '',
    '## 当前正式路径的实际运行证据',
    '',
  ];
  if (b) {
    lines.push(
      `- 已接受时间步：${b.acceptedSteps}；因失败重试：${b.rejectedSteps}；实际终点：${b.finalTime} s。`,
      `- Picard 最大轮数：${b.maxPicardIterations}；最大 T/C 更新：${b.maxPicardTemperatureUpdate.toExponential(4)} / ${b.maxPicardMoistureUpdate.toExponential(4)}。`,
      `- 最大全局尺度化 T/C 残差：${b.maxPicardTemperatureResidual.toExponential(4)} / ${b.maxPicardMoistureResidual.toExponential(4)}。`,
      `- T 范围：${b.minTemperature.toFixed(8)}—${b.maxTemperature.toFixed(8)} ℃；C 范围：${b.minMoisture.toFixed(10)}—${b.maxMoisture.toFixed(10)} kg/kg。`,
      `- 水分积分损失：${b.integralMoistureLoss.toExponential(8)}；累计表面交换：${b.cumulativeBoundaryMoistureOutflow.toExponential(8)}；水分收支差：${b.moistureBalanceError.toExponential(8)}。`,
      `- 温度方程离散收支差：${b.thermalStorageBalanceError.toExponential(8)}。该量不是完整多组分总能量守恒证明。`,
      `- 全域最大含水率阈值事件：${b.thresholdEvent ? JSON.stringify(b.thresholdEvent) : '当前运行未发生'}。`,
    );
  } else {
    lines.push('- 当前运行未生成正式状态。');
  }
  lines.push(
    '',
    '## 测试结果',
    '',
    `- 平衡边界：${JSON.stringify(tests.equilibrium)}`,
    `- 封闭边界：${JSON.stringify(tests.closed)}`,
    `- 常系数圆柱基准：${JSON.stringify(tests.bessel)}`,
    `- 变系数制造解：${JSON.stringify(tests.manufactured)}`,
    '',
    '## 口径与限制',
    '',
    '- 当前首轮只用于建立第二问独立求解路径和守护测试，尚未构成空间、时间、迭代三类正式收敛证据。',
    '- ρ、cp、k 随 C 的变化按题设有效热物性使用。模型未显式计入相变潜热、水分携带焓或收缩功。',
    '- 热收支检查针对离散温度方程的 b(C_new)WΔT 与边界换热，不表述为完整总能量守恒。',
    '- 无内部实测场数据时，不报告实验预测准确率。',
  );
  return lines.join('\n');
}

function buildWorkbook(result, title) {
  const workbook = Workbook.create();
  const temperatureSheet = workbook.worksheets.add('温度');
  const moistureSheet = workbook.worksheets.add('水分浓度');
  const header = ['时间/s 到药材中心的距离/cm', ...OUTPUT_RADII.map((radius) => Number((radius * 100).toFixed(1)))];
  const rowsTemperature = [header, ...result.store.times.map((time, i) => [time, ...result.store.temperature[i]])];
  const rowsMoisture = [header, ...result.store.times.map((time, i) => [time, ...result.store.moisture[i]])];
  const writeSheet = (sheet, rows, unit) => {
    sheet.showGridLines = false;
    sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).values = rows;
    sheet.getRangeByIndexes(0, 0, 1, rows[0].length).format = {
      fill: '#1F4E78',
      font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' },
      horizontalAlignment: 'center',
      verticalAlignment: 'center',
      wrapText: true,
    };
    sheet.getRangeByIndexes(1, 0, rows.length - 1, 1).format.numberFormat = '0.000';
    sheet.getRangeByIndexes(1, 1, rows.length - 1, rows[0].length - 1).format.numberFormat = '0.0000';
    sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).format.font = { name: 'Arial', size: 10, color: '#222222' };
    sheet.getRangeByIndexes(0, 0, 1, rows[0].length).format.font = { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' };
    sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).format.verticalAlignment = 'center';
    sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).format.borders = {
      insideHorizontal: { style: 'thin', color: '#D9E2F3' },
      insideVertical: { style: 'thin', color: '#D9E2F3' },
      bottom: { style: 'thin', color: '#A6A6A6' },
    };
    sheet.getRangeByIndexes(0, 0, rows.length, 1).format.columnWidth = 23;
    sheet.getRangeByIndexes(0, 1, 1, rows[0].length - 1).format.columnWidth = 10;
    sheet.freezePanes.freezeRows(1);
    sheet.freezePanes.freezeColumns(1);
    sheet.getRangeByIndexes(0, 0, 1, rows[0].length).format.rowHeight = 30;
    sheet.getRangeByIndexes(1, 0, rows.length - 1, rows[0].length).format.rowHeight = 16;
    sheet.getRange('W1').values = [[`${title}；单位：${unit}`]];
    sheet.getRange('W1').format.font = { name: 'Arial', size: 10, italic: true, color: '#666666' };
    sheet.getRange('W1').format.columnWidth = 34;
  };
  writeSheet(temperatureSheet, rowsTemperature, '℃');
  writeSheet(moistureSheet, rowsMoisture, 'kg/kg');
  workbook.recalculate();
  return workbook;
}

async function createRunDirectory(options) {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const runId = options.runId ?? `q2_${options.mode}_${stamp}`;
  const outputRoot = options.outputRoot ? path.resolve(projectRoot, options.outputRoot) : q2OutputRoot;
  const runDir = path.join(outputRoot, runId);
  try {
    const existing = await fs.readdir(runDir);
    if (existing.length > 0) throw new Error(`运行目录非空，拒绝覆盖: ${runDir}`);
  } catch (error) {
    if (error.code === 'ENOENT') await fs.mkdir(runDir, { recursive: false });
    else throw error;
  }
  return { runId, runDir, outputRoot };
}

async function writeArtifacts(runDir, environment, result, tests, options, elapsedMs) {
  const output = {
    run: {
      mode: options.mode,
      extension: options.extension,
      diffusionCase: options.diffusionCase,
      elapsedMs,
      projectRoot,
      inputPath,
      outputRoot: path.dirname(runDir),
    },
    parameters: {
      R,
      H_T,
      H_M,
      T0,
      C0,
      D0: initialDiffusion(),
      n: result.grid.n,
      dt: result.requestedDt,
      dr: result.grid.dr,
      diffusionMode: result.diffusionMode,
    },
    environment: {
      temperature: environment.temperaturePoints,
      moisture: environment.moisturePoints,
      extension: environment.extension,
      endpoint: environment.endpoint,
      lastHourMean: environment.lastHourMean,
    },
    times: result.store.times,
    radii_m: OUTPUT_RADII,
    temperature_C: result.store.temperature,
    moisture_kg_per_kg: result.store.moisture,
    volume_mean_temperature_C: result.store.meanTemperature,
    volume_mean_moisture_kg_per_kg: result.store.meanMoisture,
    surface_temperature_C: result.store.surfaceTemperature,
    surface_moisture_kg_per_kg: result.store.surfaceMoisture,
    balance: result.balance,
    tests,
  };
  await fs.writeFile(path.join(runDir, 'result2_internal.json'), JSON.stringify(output, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'tables_3_4.md'), reportTables(result), 'utf8');
  await fs.writeFile(path.join(runDir, 'validation_q2.md'), validationReport(environment, result, tests, options, elapsedMs), 'utf8');
  await fs.writeFile(path.join(runDir, 'run_manifest.json'), JSON.stringify({
    runId: path.basename(runDir),
    createdAt: new Date().toISOString(),
    options,
    outputs: [
      'result2_internal.json',
      'tables_3_4.md',
      'validation_q2.md',
      ...(options.noXlsx ? [] : [options.mode === 'short' ? 'result2_debug.xlsx' : 'result2.xlsx']),
    ],
  }, null, 2), 'utf8');
  if (!options.noXlsx) {
    const workbook = buildWorkbook(result, `A题第二问 ${options.mode}`);
    const xlsx = await SpreadsheetFile.exportXlsx(workbook);
    await xlsx.save(path.join(runDir, options.mode === 'short' ? 'result2_debug.xlsx' : 'result2.xlsx'));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selectedConfig = modeConfig(options.mode);
  options.n = options.n ?? selectedConfig.n;
  options.dt = options.dt ?? selectedConfig.dt;
  options.tEnd = options.tEnd ?? selectedConfig.tEnd;
  const { runId, runDir, outputRoot } = await createRunDirectory(options);
  const started = Date.now();
  const environment = await loadEnvironment(options.extension);
  const tests = { equilibrium: runEquilibriumTest(), closed: runClosedBoundaryTest(), bessel: runConstantCoefficientBesselTest(), manufactured: runManufacturedSolutionTest() };
  if (options.mode === 'tests') {
    const testOnlyResult = simulateQuestion2(makeConstantEnvironment(T0, C0), { n: 20, dt: 1, tEnd: 1, storeTimes: [0, 1], diffusionMode: diffusionMode(options.diffusionCase) });
    await writeArtifacts(runDir, environment, testOnlyResult, tests, options, Date.now() - started);
    console.log(JSON.stringify({ runId, runDir, outputRoot, tests }, null, 2));
    return;
  }
  const result = simulateQuestion2(environment, {
    n: options.n,
    dt: options.dt,
    tEnd: options.tEnd,
    storeTimes: defaultStoreTimes(options.tEnd),
    diffusionMode: diffusionMode(options.diffusionCase),
    stopAtThreshold: selectedConfig.stopAtThreshold,
  });
  await writeArtifacts(runDir, environment, result, tests, options, Date.now() - started);
  console.log(JSON.stringify({ runId, runDir, outputRoot, balance: result.balance, tests }, null, 2));
}

export {
  loadEnvironment,
  gridFor,
  coupledStep,
  simulateQuestion2,
  diffusionCoefficient,
  manufacturedFields,
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
