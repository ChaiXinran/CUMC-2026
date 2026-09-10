import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const R = 0.02;
const T_END = 1800;
const RHO = 820;
const CP = 2600;
const K = 0.36;
const H_T = 25;
const H_M = 8e-7;
const T0 = 28;
const C0 = 2.55;
const D0 = 7e-9 * Math.exp(-0.89 / C0);
const OUTPUT_RADII = Array.from({ length: 21 }, (_, i) => Number((i * 0.001).toFixed(3)));
const REPORT_TIMES = [100, 300, 600, 900, 1200, 1500, 1800];
const ALL_INTEGER_TIMES = Array.from({ length: T_END }, (_, i) => i + 1);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = path.join(projectRoot, 'CUMCM2026Problems/A题/附件/附件1.xlsx');
const outputDir = path.join(projectRoot, 'outputs');

function maxAbs(values) {
  let result = 0;
  for (const value of values) result = Math.max(result, Math.abs(value));
  return result;
}

function maxAbsDiff(a, b) {
  let result = 0;
  for (let i = 0; i < a.length; i++) result = Math.max(result, Math.abs(a[i] - b[i]));
  return result;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
  const w = (t - t0) / (t1 - t0);
  return y0 + w * (y1 - y0);
}

function gridFor(n) {
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
  const x = radius / (radii[1] - radii[0]);
  const i = Math.min(radii.length - 2, Math.floor(x));
  const w = x - i;
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

function solveTridiagonal(lower, diagonal, upper, rhs) {
  const n = diagonal.length;
  const a = lower.slice();
  const b = diagonal.slice();
  const c = upper.slice();
  const d = rhs.slice();
  for (let i = 1; i < n; i++) {
    const factor = a[i] / b[i - 1];
    b[i] -= factor * c[i - 1];
    d[i] -= factor * d[i - 1];
  }
  const x = new Array(n);
  x[n - 1] = d[n - 1] / b[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = (d[i] - c[i] * x[i + 1]) / b[i];
  return x;
}

function assembleLinearSystem(grid, oldState, dt, capacity, faceCoefficient, exchangeCoefficient, environment) {
  const size = grid.n + 1;
  const lower = new Array(size).fill(0);
  const diagonal = new Array(size).fill(0);
  const upper = new Array(size).fill(0);
  const rhs = new Array(size);
  for (let i = 0; i <= grid.n; i++) {
    const storage = capacity * grid.weights[i] / dt;
    const left = i === 0 ? 0 : grid.faces[i - 1] * faceCoefficient[i - 1] / grid.dr;
    const right = i === grid.n
      ? R * exchangeCoefficient
      : grid.faces[i] * faceCoefficient[i] / grid.dr;
    diagonal[i] = storage + left + right;
    rhs[i] = storage * oldState[i];
    if (i > 0) lower[i] = -left;
    if (i < grid.n) upper[i] = -right;
    if (i === grid.n) rhs[i] += R * exchangeCoefficient * environment;
  }
  return { lower, diagonal, upper, rhs };
}

function solveLinearStep(grid, oldState, dt, capacity, faceCoefficient, exchangeCoefficient, environment) {
  const system = assembleLinearSystem(
    grid,
    oldState,
    dt,
    capacity,
    faceCoefficient,
    exchangeCoefficient,
    environment,
  );
  return solveTridiagonal(system.lower, system.diagonal, system.upper, system.rhs);
}

function diffusionCoefficient(c) {
  if (!(c > 0) || !Number.isFinite(c)) throw new Error(`非正或非有限含水率: ${c}`);
  return 7e-9 * Math.exp(-0.89 / c);
}

function harmonicMean(a, b) {
  return (2 * a * b) / (a + b);
}

function waterResidual(grid, oldState, newState, dt, cInf) {
  const nodeD = newState.map(diffusionCoefficient);
  const faceD = nodeD.slice(0, -1).map((d, i) => harmonicMean(d, nodeD[i + 1]));
  let scale = 0;
  let absoluteResidual = 0;
  for (let i = 0; i <= grid.n; i++) {
    const leftFlux = i === 0
      ? 0
      : -grid.faces[i - 1] * faceD[i - 1] * (newState[i] - newState[i - 1]) / grid.dr;
    const rightFlux = i === grid.n
      ? R * H_M * (newState[i] - cInf)
      : -grid.faces[i] * faceD[i] * (newState[i + 1] - newState[i]) / grid.dr;
    const lhs = grid.weights[i] * (newState[i] - oldState[i]) / dt;
    const localScale = Math.max(Math.abs(lhs), Math.abs(leftFlux), Math.abs(rightFlux));
    absoluteResidual = Math.max(absoluteResidual, Math.abs(lhs - leftFlux + rightFlux));
    scale = Math.max(scale, localScale);
  }
  return { relative: absoluteResidual / Math.max(1e-10, scale), scale, absolute: absoluteResidual };
}

function solveWaterStep(grid, oldState, dt, cInf, options = {}) {
  const maxIterations = options.maxIterations ?? 100;
  const updateTolerance = options.updateTolerance ?? 2e-11;
  const residualTolerance = options.residualTolerance ?? 2e-9;
  const relaxation = options.relaxation ?? 0.8;
  let guess = oldState.slice();
  let lastResidual = Infinity;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const nodeD = guess.map(diffusionCoefficient);
    const faceD = nodeD.slice(0, -1).map((d, i) => harmonicMean(d, nodeD[i + 1]));
    const raw = solveLinearStep(grid, oldState, dt, 1, faceD, H_M, cInf);
    const next = raw.map((value, i) => guess[i] + relaxation * (value - guess[i]));
    if (next.some((value) => !(value > 0) || !Number.isFinite(value))) {
      throw new Error(`Picard 更新出现非正或非有限含水率 (iteration=${iteration})`);
    }
    const update = maxAbsDiff(next, guess) / Math.max(1, maxAbs(next));
    lastResidual = waterResidual(grid, oldState, next, dt, cInf).relative;
    guess = next;
    if (update < updateTolerance && lastResidual < residualTolerance) {
      return { state: guess, iterations: iteration, residual: lastResidual };
    }
  }
  throw new Error(`Picard 未收敛: residual=${lastResidual}`);
}

function makeEnvironment(rows) {
  const temperature = rows.map((row) => [Number(row[0]), Number(row[1])]).filter((row) => row[0] <= T_END);
  const moisture = rows.map((row) => [Number(row[0]), Number(row[2])]).filter((row) => row[0] <= T_END);
  return {
    temperature: (t) => linInterp(temperature, t),
    moisture: (t) => linInterp(moisture, t),
    temperaturePoints: temperature,
    moisturePoints: moisture,
  };
}

async function loadEnvironment() {
  const input = await FileBlob.load(inputPath);
  const workbook = await SpreadsheetFile.importXlsx(input);
  const sheet = workbook.worksheets.getItemAt(0);
  const values = sheet.getUsedRange(true).values;
  return makeEnvironment(values.slice(1).filter((row) => row[0] !== null && row[0] !== undefined));
}

function emptyRecordStore() {
  return { times: [], temperature: [], moisture: [], meanTemperature: [], meanMoisture: [] };
}

function storeRecord(store, time, grid, temperature, moisture) {
  store.times.push(time);
  store.temperature.push(sampleState(grid, temperature));
  store.moisture.push(sampleState(grid, moisture));
  store.meanTemperature.push(weightedAverage(grid, temperature));
  store.meanMoisture.push(weightedAverage(grid, moisture));
}

function sumWeighted(grid, state) {
  return grid.weights.reduce((sum, weight, i) => sum + weight * state[i], 0);
}

function shouldStore(t, requestedTimes) {
  if (!requestedTimes) return false;
  return requestedTimes.some((time) => Math.abs(time - t) < 1e-8);
}

function simulateQuestion1(environment, options = {}) {
  const n = options.n ?? 80;
  const requestedDt = options.dt ?? 0.25;
  const requestedTimes = options.storeTimes ?? ALL_INTEGER_TIMES;
  const grid = gridFor(n);
  const temperature = new Array(n + 1).fill(T0);
  const moisture = new Array(n + 1).fill(C0);
  const store = emptyRecordStore();
  const balance = {
    initialMoistureIntegral: sumWeighted(grid, moisture),
    cumulativeBoundaryOutflow: 0,
    maxPicardIterations: 0,
    maxPicardResidual: 0,
    acceptedSteps: 0,
    rejectedSteps: 0,
    minTemperature: T0,
    maxTemperature: T0,
    minMoisture: C0,
    maxMoisture: C0,
  };
  let t = 0;
  let dt = requestedDt;
  while (t < T_END - 1e-10) {
    const nextRequestedTime = requestedTimes.find((time) => time > t + 1e-8);
    const target = nextRequestedTime ?? T_END;
    const dtStep = Math.min(dt, target - t, T_END - t);
    const nextTime = t + dtStep;
    try {
      const tInf = environment.temperature(nextTime);
      const cInf = environment.moisture(nextTime);
      const nextTemperature = solveLinearStep(
        grid,
        temperature,
        dtStep,
        RHO * CP,
        new Array(n).fill(K),
        H_T,
        tInf,
      );
      const water = solveWaterStep(grid, moisture, dtStep, cInf);
      temperature.splice(0, temperature.length, ...nextTemperature);
      moisture.splice(0, moisture.length, ...water.state);
      t = nextTime;
      balance.cumulativeBoundaryOutflow += dtStep * R * H_M * (moisture[n] - cInf);
      balance.maxPicardIterations = Math.max(balance.maxPicardIterations, water.iterations);
      balance.maxPicardResidual = Math.max(balance.maxPicardResidual, water.residual);
      balance.acceptedSteps++;
      balance.minTemperature = Math.min(balance.minTemperature, ...temperature);
      balance.maxTemperature = Math.max(balance.maxTemperature, ...temperature);
      balance.minMoisture = Math.min(balance.minMoisture, ...moisture);
      balance.maxMoisture = Math.max(balance.maxMoisture, ...moisture);
      if (shouldStore(t, requestedTimes)) storeRecord(store, Math.round(t), grid, temperature, moisture);
    } catch (error) {
      if (dt <= requestedDt / 128) throw error;
      dt *= 0.5;
      balance.rejectedSteps++;
    }
  }
  balance.finalMoistureIntegral = sumWeighted(grid, moisture);
  balance.integralLoss = balance.initialMoistureIntegral - balance.finalMoistureIntegral;
  balance.massBalanceError = balance.integralLoss - balance.cumulativeBoundaryOutflow;
  return { grid, store, balance, requestedDt, finalTemperature: temperature, finalMoisture: moisture };
}

function besselJ0(x) {
  let term = 1;
  let sum = 1;
  const z = -(x * x) / 4;
  for (let m = 1; m < 100; m++) {
    term *= z / (m * m);
    sum += term;
    if (Math.abs(term) < 1e-16 * Math.max(1, Math.abs(sum))) break;
  }
  return sum;
}

function besselJ1(x) {
  let term = x / 2;
  let sum = term;
  const z = -(x * x) / 4;
  for (let m = 1; m < 100; m++) {
    term *= z / (m * (m + 1));
    sum += term;
    if (Math.abs(term) < 1e-16 * Math.max(1, Math.abs(sum))) break;
  }
  return sum;
}

function firstBesselRoot(biot) {
  const f = (mu) => mu * besselJ1(mu) - biot * besselJ0(mu);
  let left = 1e-6;
  let fLeft = f(left);
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
      return 0.5 * (a + b);
    }
    left = right;
    fLeft = fRight;
  }
  throw new Error(`未找到 Bessel 第一特征根, Bi=${biot}`);
}

function simulateBesselReference({ diffusivity, capacity, conductivity, exchange, n = 80, dt = 1, tEnd = 1800 }) {
  const grid = gridFor(n);
  const biot = exchange * R / conductivity;
  const mu = firstBesselRoot(biot);
  const environmentValue = 30;
  const amplitude = 5;
  const initial = grid.radii.map((radius) => environmentValue + amplitude * besselJ0(mu * radius / R));
  let state = initial.slice();
  let t = 0;
  while (t < tEnd - 1e-10) {
    const step = Math.min(dt, tEnd - t);
    state = solveLinearStep(
      grid,
      state,
      step,
      capacity,
      new Array(n).fill(conductivity),
      exchange,
      environmentValue,
    );
    t += step;
  }
  const decay = Math.exp(-(diffusivity * mu * mu * tEnd) / (R * R));
  const exact = grid.radii.map((radius) => environmentValue + amplitude * besselJ0(mu * radius / R) * decay);
  return { mu, biot, maxError: maxAbsDiff(state, exact), finalState: state, exact };
}

function runEquilibriumAndClosedTests() {
  const n = 20;
  const grid = gridFor(n);
  const constantT = new Array(n + 1).fill(T0);
  const constantC = new Array(n + 1).fill(C0);
  let tState = constantT.slice();
  let cState = constantC.slice();
  for (let i = 0; i < 100; i++) {
    tState = solveLinearStep(grid, tState, 1, RHO * CP, new Array(n).fill(K), H_T, T0);
    const water = solveWaterStep(grid, cState, 1, C0);
    cState = water.state;
  }
  const equilibrium = { temperatureMaxChange: maxAbsDiff(tState, constantT), moistureMaxChange: maxAbsDiff(cState, constantC) };

  const initialT = grid.radii.map((radius) => 28 + 3 * (radius / R) ** 2);
  const initialC = grid.radii.map((radius) => 1.2 + 0.4 * (radius / R) ** 2);
  let closedT = initialT.slice();
  let closedC = initialC.slice();
  const initialTIntegral = sumWeighted(grid, closedT);
  const initialCIntegral = sumWeighted(grid, closedC);
  for (let i = 0; i < 100; i++) {
    closedT = solveLinearStep(grid, closedT, 1, RHO * CP, new Array(n).fill(K), 0, 0);
    const nodeD = closedC.map(diffusionCoefficient);
    const faceD = nodeD.slice(0, -1).map((d, j) => harmonicMean(d, nodeD[j + 1]));
    closedC = solveLinearStep(grid, closedC, 1, 1, faceD, 0, 0);
  }
  const closed = {
    heatRelativeIntegralError: Math.abs(sumWeighted(grid, closedT) - initialTIntegral) / Math.max(1, Math.abs(initialTIntegral)),
    moistureRelativeIntegralError: Math.abs(sumWeighted(grid, closedC) - initialCIntegral) / Math.max(1, Math.abs(initialCIntegral)),
  };
  return { equilibrium, closed };
}

function compareRuns(reference, candidate) {
  const byTime = new Map(reference.store.times.map((time, i) => [time, i]));
  let maxTemperature = 0;
  let maxMoisture = 0;
  let maxMeanTemperature = 0;
  let maxMeanMoisture = 0;
  for (let i = 0; i < candidate.store.times.length; i++) {
    const time = candidate.store.times[i];
    const j = byTime.get(time);
    if (j === undefined) continue;
    maxTemperature = Math.max(maxTemperature, maxAbsDiff(reference.store.temperature[j], candidate.store.temperature[i]));
    maxMoisture = Math.max(maxMoisture, maxAbsDiff(reference.store.moisture[j], candidate.store.moisture[i]));
    maxMeanTemperature = Math.max(maxMeanTemperature, Math.abs(reference.store.meanTemperature[j] - candidate.store.meanTemperature[i]));
    maxMeanMoisture = Math.max(maxMeanMoisture, Math.abs(reference.store.meanMoisture[j] - candidate.store.meanMoisture[i]));
  }
  const specified = REPORT_TIMES.map((time) => {
    const i = byTime.get(time);
    const j = candidate.store.times.indexOf(time);
    if (i === undefined || j < 0) return { time, maxTemperature: null, maxMoisture: null, maxMeanTemperature: null, maxMeanMoisture: null };
    return {
      time,
      maxTemperature: maxAbsDiff(reference.store.temperature[i], candidate.store.temperature[j]),
      maxMoisture: maxAbsDiff(reference.store.moisture[i], candidate.store.moisture[j]),
      maxMeanTemperature: Math.abs(reference.store.meanTemperature[i] - candidate.store.meanTemperature[j]),
      maxMeanMoisture: Math.abs(reference.store.meanMoisture[i] - candidate.store.meanMoisture[j]),
    };
  });
  return { maxTemperature, maxMoisture, maxMeanTemperature, maxMeanMoisture, specified };
}

function formatNumber(value) {
  return Number(value.toFixed(12));
}

function buildWorkbook(result) {
  const workbook = Workbook.create();
  const sheets = [
    ['温度', result.store.temperature, '°C'],
    ['水分浓度', result.store.moisture, 'kg/kg'],
  ];
  const header = ['时间/s 到药材中心的距离/cm', ...OUTPUT_RADII.map((radius) => Number((radius * 100).toFixed(1)))];
  for (const [name, records, unit] of sheets) {
    const sheet = workbook.worksheets.add(name);
    const rows = [header, ...result.store.times.map((time, i) => [time, ...records[i]])];
    sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).values = rows;
    sheet.showGridLines = false;
    sheet.getRangeByIndexes(0, 0, 1, rows[0].length).format = {
      fill: '#1F4E78',
      font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' },
      horizontalAlignment: 'center',
      verticalAlignment: 'center',
      wrapText: true,
    };
    sheet.getRangeByIndexes(1, 0, rows.length - 1, 1).format.numberFormat = '0';
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
  }
  workbook.recalculate();
  return workbook;
}

function reportMarkdown(environment, result, checks, convergence, bessel, constantDResult) {
  const b = result.balance;
  const lines = [
    '# A题第一问：数值实现与验证记录',
    '',
    '## 实施配置',
    '',
    `- 模型：中部横截面一维径向有效传热与非线性水分扩散，温度场和水分场解耦。`,
    `- 网格：N=${result.grid.n} 个径向区间，Δr=${(result.grid.dr * 100).toFixed(4)} cm；内部推进步长请求值 ${result.requestedDt} s。`,
    `- 时间：0–${T_END} s；环境数据采用附件 1 的前 1800 s、31 个点的分段线性插值。`,
    `- 热参数：ρ=${RHO} kg/m³，cp=${CP} J/(kg·K)，k=${K} W/(m·K)，h=${H_T} W/(m²·K)。`,
    `- 传质参数：hm=${H_M} m/s，D(C)=7×10⁻⁹ exp(-0.89/C) m²/s；水分场采用调和平均界面系数和阻尼 Picard 迭代。`,
    `- 结果表格采用每 1 s、每 0.1 cm 输出，未将输出间隔当作内部计算精度限制。`,
    '',
    '## 实际运行证据',
    '',
    `- 接受时间步：${b.acceptedSteps}；因非线性迭代失败而重试的步数：${b.rejectedSteps}。`,
    `- Picard 最大迭代次数：${b.maxPicardIterations}；记录的最大相对方程残差：${b.maxPicardResidual.toExponential(4)}。`,
    `- 计算过程中温度范围：${b.minTemperature.toFixed(8)}–${b.maxTemperature.toFixed(8)} °C。`,
    `- 计算过程中含水率范围：${b.minMoisture.toFixed(10)}–${b.maxMoisture.toFixed(10)} kg/kg，未用截断负值掩盖迭代问题。`,
    `- 1800 s 归一化含水量积分损失：${b.integralLoss.toExponential(8)}；边界累计交换量：${b.cumulativeBoundaryOutflow.toExponential(8)}；收支差：${b.massBalanceError.toExponential(8)}。`,
    '',
    '## 基础测试',
    '',
    `- 平衡状态测试（环境与初值相同，100 s）：温度最大变化 ${checks.equilibrium.temperatureMaxChange.toExponential(4)}，含水率最大变化 ${checks.equilibrium.moistureMaxChange.toExponential(4)}。`,
    `- 封闭边界测试（h=0，100 s）：热积分相对误差 ${checks.closed.heatRelativeIntegralError.toExponential(4)}，含水率积分相对误差 ${checks.closed.moistureRelativeIntegralError.toExponential(4)}。`,
    `- 独立常系数 Bessel 基准（N=80，dt=1 s，1800 s）：热 Bi=${bessel.heat.biot.toFixed(8)}，μ=${bessel.heat.mu.toFixed(8)}，最大绝对误差 ${bessel.heat.maxError.toExponential(4)}；水分 Bi=${bessel.moisture.biot.toFixed(8)}，μ=${bessel.moisture.mu.toFixed(8)}，最大绝对误差 ${bessel.moisture.maxError.toExponential(4)}。`,
    '',
    '## 独立空间与时间检验',
    '',
    '| 检验 | 对照 | 全过程最大温度差 / °C | 全过程最大含水率差 / kg/kg | 体积平均温度差 / °C | 体积平均含水率差 / kg/kg |',
    '|---|---|---:|---:|---:|---:|',
    ...convergence.map((row) => `| ${row.type} | ${row.case} | ${row.compare.maxTemperature.toExponential(4)} | ${row.compare.maxMoisture.toExponential(4)} | ${row.compare.maxMeanTemperature.toExponential(4)} | ${row.compare.maxMeanMoisture.toExponential(4)} |`),
    '',
    '指定时刻的全场最大差：',
    '',
    '| 检验 | 时刻/s | 最大温度差 / °C | 最大含水率差 / kg/kg |',
    '|---|---:|---:|---:|',
    ...convergence.flatMap((row) => row.compare.specified.map((item) => `| ${row.type}: ${row.case} | ${item.time} | ${item.maxTemperature.toExponential(4)} | ${item.maxMoisture.toExponential(4)} |`)),
    '',
    '## 非线性扩散对照',
    '',
    `正式模型和常扩散对照使用相同网格、时间步、Robin 边界与环境插值。将 D 固定为初始值 D(C₀)=${D0.toExponential(8)} m²/s 后，1800 s 全过程最大表面含水率差为 ${constantDResult.maxSurfaceMoistureDifference.toExponential(4)} kg/kg，最大体积平均含水率差为 ${constantDResult.maxMeanMoistureDifference.toExponential(4)} kg/kg，最大径向场差为 ${constantDResult.maxFieldMoistureDifference.toExponential(4)} kg/kg。该对照用于量化保留 D(C) 的影响，不替代正式模型。`,
    '',
    '## 结果与局限',
    '',
    '- `result1.xlsx` 中两张表分别保存温度和水分浓度，保留计算值并按四位小数显示。',
    '- 收支检查是有效浓度方程的归一化收支，不直接等同于真实失水质量；若报告真实质量，需要另给有效干固体密度。',
    '- 该实现针对题目第一问的中部截面和 1800 s 预热观察窗，不把它外推为整根药材全程无轴向差异，也不包含潜热反馈、收缩或温度依赖扩散系数。',
    '- 没有内部实测场数据，因此未给出实验预测准确率。',
  ];
  return lines.join('\n');
}

function tablesMarkdown(result) {
  const outputIndices = [0, 5, 10, 15, 20];
  const header = ['时间/s', ...outputIndices.map((i) => `${OUTPUT_RADII[i] * 100}`)];
  const separator = '|---:|' + outputIndices.map(() => '---:').join('|') + '|';
  const makeTable = (title, values) => {
    const lines = [title, '', `| ${header.join(' | ')} |`, separator];
    for (const time of REPORT_TIMES) {
      const row = result.store.times.indexOf(time);
      lines.push(`| ${time} | ${outputIndices.map((i) => values[row][i].toFixed(4)).join(' | ')} |`);
    }
    return lines.join('\n');
  };
  return [
    '# A题第一问表1、表2',
    '',
    makeTable('## 表1 预热阶段药材温度（°C）', result.store.temperature),
    '',
    makeTable('## 表2 预热阶段药材水分浓度（kg/kg）', result.store.moisture),
    '',
    '注：正式 Excel 输出保留内部计算值并按四位小数显示；本文件仅列出论文所需的五个半径位置。',
  ].join('\n');
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const environment = await loadEnvironment();
  const requestedTimes = ALL_INTEGER_TIMES;
  console.log('运行基础测试...');
  const checks = runEquilibriumAndClosedTests();
  console.log('运行 Bessel 基准...');
  const bessel = {
    heat: simulateBesselReference({ diffusivity: K / (RHO * CP), capacity: RHO * CP, conductivity: K, exchange: H_T }),
    moisture: simulateBesselReference({ diffusivity: D0, capacity: 1, conductivity: D0, exchange: H_M }),
  };
  console.log('运行正式模型 N=320, dt=0.125 s...');
  const baseline = simulateQuestion1(environment, { n: 320, dt: 0.125, storeTimes: requestedTimes });
  console.log('运行空间收敛组...');
  const spatial80 = simulateQuestion1(environment, { n: 80, dt: 0.125, storeTimes: requestedTimes });
  const spatial160 = simulateQuestion1(environment, { n: 160, dt: 0.125, storeTimes: requestedTimes });
  console.log('运行时间收敛组...');
  const time025 = simulateQuestion1(environment, { n: 320, dt: 0.25, storeTimes: requestedTimes });
  const time05 = simulateQuestion1(environment, { n: 320, dt: 0.5, storeTimes: requestedTimes });
  const convergence = [
    { type: '空间', case: 'N=80, dt=0.125 对 N=320, dt=0.125', compare: compareRuns(baseline, spatial80) },
    { type: '空间', case: 'N=160, dt=0.125 对 N=320, dt=0.125', compare: compareRuns(baseline, spatial160) },
    { type: '时间', case: 'N=320, dt=0.25 对 N=320, dt=0.125', compare: compareRuns(baseline, time025) },
    { type: '时间', case: 'N=320, dt=0.5 对 N=320, dt=0.125', compare: compareRuns(baseline, time05) },
  ];
  console.log('运行常扩散对照...');
  const constantD = simulateQuestion1WithConstantD(environment, { n: 320, dt: 0.125, storeTimes: requestedTimes, diffusivity: D0 });
  const constantDResult = compareConstantD(baseline, constantD);
  const workbook = buildWorkbook(baseline);
  const xlsx = await SpreadsheetFile.exportXlsx(workbook);
  await xlsx.save(path.join(outputDir, 'result1.xlsx'));

  const output = {
    parameters: { R, T_END, RHO, CP, K, H_T, H_M, T0, C0, D0, n: baseline.grid.n, dt: baseline.requestedDt, dr: baseline.grid.dr },
    environment: { temperature: environment.temperaturePoints, moisture: environment.moisturePoints },
    times: baseline.store.times,
    radii_m: OUTPUT_RADII,
    temperature_C: baseline.store.temperature,
    moisture_kg_per_kg: baseline.store.moisture,
    volume_mean_temperature_C: baseline.store.meanTemperature,
    volume_mean_moisture_kg_per_kg: baseline.store.meanMoisture,
    balance: baseline.balance,
    checks,
    bessel,
    convergence,
    constantD: constantDResult,
  };
  await fs.writeFile(path.join(outputDir, 'result1_internal.json'), JSON.stringify(output, null, 2), 'utf8');
  await fs.writeFile(path.join(outputDir, 'validation_report.md'), reportMarkdown(environment, baseline, checks, convergence, bessel, constantDResult), 'utf8');
  await fs.writeFile(path.join(outputDir, 'tables_1_2.md'), tablesMarkdown(baseline), 'utf8');
  console.log(`输出已保存到 ${outputDir}`);
  console.log(JSON.stringify({ balance: baseline.balance, checks, convergence, constantD: constantDResult }, null, 2));
}

function simulateQuestion1WithConstantD(environment, options = {}) {
  const n = options.n ?? 80;
  const requestedDt = options.dt ?? 0.25;
  const requestedTimes = options.storeTimes ?? ALL_INTEGER_TIMES;
  const grid = gridFor(n);
  const temperature = new Array(n + 1).fill(T0);
  const moisture = new Array(n + 1).fill(C0);
  const store = emptyRecordStore();
  let t = 0;
  while (t < T_END - 1e-10) {
    const nextRequestedTime = requestedTimes.find((time) => time > t + 1e-8);
    const target = nextRequestedTime ?? T_END;
    const dtStep = Math.min(requestedDt, target - t, T_END - t);
    const tInf = environment.temperature(t + dtStep);
    const cInf = environment.moisture(t + dtStep);
    const nextTemperature = solveLinearStep(grid, temperature, dtStep, RHO * CP, new Array(n).fill(K), H_T, tInf);
    const nextMoisture = solveLinearStep(grid, moisture, dtStep, 1, new Array(n).fill(options.diffusivity), H_M, cInf);
    temperature.splice(0, temperature.length, ...nextTemperature);
    moisture.splice(0, moisture.length, ...nextMoisture);
    t += dtStep;
    if (shouldStore(t, requestedTimes)) storeRecord(store, Math.round(t), grid, temperature, moisture);
  }
  return { grid, store };
}

function compareConstantD(formal, constantD) {
  const byTime = new Map(constantD.store.times.map((time, i) => [time, i]));
  let maxSurfaceMoistureDifference = 0;
  let maxMeanMoistureDifference = 0;
  let maxFieldMoistureDifference = 0;
  for (let i = 0; i < formal.store.times.length; i++) {
    const j = byTime.get(formal.store.times[i]);
    if (j === undefined) continue;
    maxSurfaceMoistureDifference = Math.max(
      maxSurfaceMoistureDifference,
      Math.abs(formal.store.moisture[i][20] - constantD.store.moisture[j][20]),
    );
    maxMeanMoistureDifference = Math.max(
      maxMeanMoistureDifference,
      Math.abs(formal.store.meanMoisture[i] - constantD.store.meanMoisture[j]),
    );
    maxFieldMoistureDifference = Math.max(
      maxFieldMoistureDifference,
      maxAbsDiff(formal.store.moisture[i], constantD.store.moisture[j]),
    );
  }
  return { maxSurfaceMoistureDifference, maxMeanMoistureDifference, maxFieldMoistureDifference };
}

export {
  loadEnvironment,
  simulateQuestion1,
  simulateQuestion1WithConstantD,
  compareRuns,
  gridFor,
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
