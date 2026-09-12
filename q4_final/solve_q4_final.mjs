import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import { makeRadiusModel, simulateQuestion4 } from '../code_q4/solve_q4_refined.mjs';
import { buildShrinkLaw, makeEnvironment, simulateCoupledShrink } from '../code_q4_shrink/solve_q4_shrink_coupled.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environmentInputPath = path.join(projectRoot, 'CUMCM2026Problems', 'A题', '附件', '附件1.xlsx');
const radiusInputPath = path.join(projectRoot, 'CUMCM2026Problems', 'A题', '附件', '附件2.xlsx');
const defaultConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'q4_final_config.json');
const defaultOutputRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');
const DEFAULT_T_END = 259200;
const THRESHOLD_C = 0.15;
const STAGE_THRESHOLDS = [0.6, 0.3, 0.2, 0.15];
const OUTPUT_RADII_M = Array.from({ length: 20 }, (_, i) => i * 0.001);

function csv(rows) {
  return rows.map((row) => row.map((value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\n');
}

function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function linearAt(times, values, time) {
  if (time <= times[0]) return values[0];
  if (time >= times[times.length - 1]) return values[values.length - 1];
  const hi = lowerBound(times, time);
  if (Math.abs(times[hi] - time) <= 1e-8) return values[hi];
  const lo = hi - 1;
  const w = (time - times[lo]) / (times[hi] - times[lo]);
  return values[lo] * (1 - w) + values[hi] * w;
}

function fmt(value, digits = 8) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : Number(value).toFixed(digits);
}

async function loadConfig(configPath = defaultConfigPath) {
  return JSON.parse(await fs.readFile(path.resolve(configPath), 'utf8'));
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

function referenceMetadata(config, inputs, law) {
  return {
    environment: {
      extension: inputs.environment.extension,
      windowSeconds: inputs.environment.windowSeconds,
      windowStart: inputs.environment.windowStart,
      windowMethod: inputs.environment.windowMethod,
      windowPointCount: inputs.environment.windowPointCount,
      lastWindowMean: inputs.environment.lastWindowMean,
      endpoint: inputs.environment.endpoint,
    },
    shrinkage: {
      p: law.p,
      Ce: law.Ce,
      R0_m: 0.02,
      Rtail_m: law.rTail,
      lambda: law.lambda,
      tailCount: law.tailCount,
      lambdaMethod: law.lambdaMethod,
      note: 'p来自已有半径训练标定；Ce是Robin闭合下沿用的末段环境含水率，不是独立实测平衡含水率。',
    },
  };
}

async function runReference(config, inputs, runDir) {
  const law = buildShrinkLaw(inputs.pchip, inputs.environment, config.shrinkage.p, config.shrinkage.tailCount);
  const options = {
    n: config.reference.n,
    dt: config.reference.dt_s,
    tEnd: config.reference.tEnd_s ?? DEFAULT_T_END,
    outputInterval: config.reference.outputInterval_s,
    mesh: config.main.mesh,
    stopAtThreshold: false,
    progressPath: path.join(runDir, 'progress.jsonl'),
    progressLabel: `reference-N${config.reference.n}-dt${config.reference.dt_s}`,
    progressIntervalSeconds: config.reference.progressInterval_s,
  };
  await fs.mkdir(runDir, { recursive: true });
  console.log(`[q4-final] 开始参考进程 N=${options.n}, dt=${options.dt}s, tEnd=${options.tEnd}s；达标后继续推进。`);
  const simulation = simulateCoupledShrink(inputs.environment, law, options);
  const times = simulation.store.times.slice();
  const cbar = simulation.store.cbar.slice();
  const mr = simulation.store.mr.slice();
  const s = mr.map((value) => value ** law.p);
  const metadata = referenceMetadata(config, inputs, law);
  const payload = {
    manifest: {
      kind: 'q4_final_reference_progress',
      source: 'fresh_reference_run',
      n: options.n,
      requestedDt_s: options.dt,
      tEnd_s: options.tEnd,
      outputInterval_s: options.outputInterval,
      arrays: ['time_s', 'Cbar', 'MR', 's=MR^p'],
    },
    ...metadata,
    balance: simulation.balance,
    thresholdEvent: simulation.thresholdEvent,
    time_s: times,
    Cbar: cbar,
    MR: mr,
    s,
  };
  await fs.writeFile(path.join(runDir, 'reference_progress.json'), JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'reference_progress.csv'), csv([
    ['time_s', 'Cbar', 'MR', 's_MR_power_p'],
    ...times.map((time, i) => [time, cbar[i], mr[i], s[i]]),
  ]), 'utf8');
  await fs.writeFile(path.join(runDir, 'reference_summary.json'), JSON.stringify({ manifest: payload.manifest, ...metadata, balance: simulation.balance, thresholdEvent: simulation.thresholdEvent, samples: times.length, firstTime_s: times[0], lastTime_s: times[times.length - 1] }, null, 2), 'utf8');
  return { payload, law };
}

function buildObservedProcessRadius(reference, radiusModel, config) {
  const times = reference.time_s;
  const s = reference.s;
  if (!Array.isArray(times) || !Array.isArray(s) || times.length !== s.length || times.length < 2) throw new Error('reference_progress缺少有效的time_s/s数组');
  const points = radiusModel.points;
  const denominatorTolerance = config.geometry.sDenominatorTolerance;
  const thetaTolerance = config.geometry.thetaRoundoffTolerance;
  const monotonicTolerance = config.geometry.referenceMonotonicTolerance;
  const intervals = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [t0, r0] = points[i];
    const [t1, r1] = points[i + 1];
    const start = lowerBound(times, t0);
    const end = lowerBound(times, t1);
    if (start >= times.length || end >= times.length || Math.abs(times[start] - t0) > 1e-8 || Math.abs(times[end] - t1) > 1e-8) throw new Error(`实测半径时刻未落在reference_progress网格: ${t0}, ${t1}`);
    const s0 = s[start];
    const s1 = s[end];
    let reason = null;
    if (Math.abs(s1 - s0) <= denominatorTolerance) reason = 'small_s_denominator';
    else {
      const lo = Math.min(s0, s1) - monotonicTolerance;
      const hi = Math.max(s0, s1) + monotonicTolerance;
      for (let j = start; j <= end; j++) {
        if (s[j] < lo || s[j] > hi) {
          reason = 'reference_s_nonmonotonic_or_out_of_endpoint_range';
          break;
        }
      }
    }
    intervals.push({ index: i, t0, t1, r0, r1, s0, s1, mode: reason ? 'time_linear_fallback' : 'reference_process', fallbackReason: reason });
  }
  const dynamicFallbacks = [];
  const radius = (time) => {
    if (time <= points[0][0] + 1e-8) return points[0][1];
    if (time >= points[points.length - 1][0] - 1e-8) return points[points.length - 1][1];
    const hi = lowerBound(points.map((point) => point[0]), time);
    if (hi < points.length && Math.abs(points[hi][0] - time) <= 1e-8) return points[hi][1];
    const i = Math.max(0, hi - 1);
    const interval = intervals[i];
    const timeTheta = (time - interval.t0) / (interval.t1 - interval.t0);
    const fallback = () => Math.sqrt(Math.max(0, (1 - timeTheta) * interval.r0 ** 2 + timeTheta * interval.r1 ** 2));
    if (interval.mode === 'time_linear_fallback') return fallback();
    const theta = (linearAt(times, s, time) - interval.s0) / (interval.s1 - interval.s0);
    if (theta < -thetaTolerance || theta > 1 + thetaTolerance) {
      if (dynamicFallbacks.length < 20) dynamicFallbacks.push({ interval: interval.index, time, theta, reason: 'runtime_theta_out_of_range' });
      return fallback();
    }
    const boundedTheta = Math.max(0, Math.min(1, theta));
    return Math.sqrt(Math.max(0, (1 - boundedTheta) * interval.r0 ** 2 + boundedTheta * interval.r1 ** 2));
  };
  const residuals = points.map(([time, observed]) => ({ time, observed, fitted: radius(time), residual: radius(time) - observed }));
  const fallbackIntervals = intervals.filter((interval) => interval.mode === 'time_linear_fallback').map((interval) => ({ index: interval.index, t0: interval.t0, t1: interval.t1, reason: interval.fallbackReason }));
  return {
    points,
    lastTime: radiusModel.lastTime,
    terminalRadius: radiusModel.terminalRadius,
    method: 'observedProcessConstrained',
    radius,
    residuals,
    intervalViolations: [],
    intervals,
    fallbackIntervals,
    dynamicFallbacks,
    geometryDefinition: 'R_H(t)^2=(1-theta)R_i^2+theta R_{i+1}^2; theta from dense reference s(t)=MR(t)^p; time-linear fallback only for invalid reference intervals.',
  };
}

function auditGeometry(radiusModel, reference) {
  let maxEndpointResidual = 0;
  for (const row of radiusModel.residuals) maxEndpointResidual = Math.max(maxEndpointResidual, Math.abs(row.residual));
  let minRadius = Infinity;
  let maxRadius = -Infinity;
  let outOfBoundsSamples = 0;
  for (let i = 0; i < reference.time_s.length; i++) {
    const time = reference.time_s[i];
    const radius = radiusModel.radius(time);
    minRadius = Math.min(minRadius, radius);
    maxRadius = Math.max(maxRadius, radius);
    const pointIndex = lowerBound(radiusModel.points.map((point) => point[0]), time);
    if (pointIndex < radiusModel.points.length && Math.abs(radiusModel.points[pointIndex][0] - time) <= 1e-8) continue;
    const intervalIndex = Math.max(0, pointIndex - 1);
    const lo = Math.min(radiusModel.points[intervalIndex][1], radiusModel.points[intervalIndex + 1][1]);
    const hi = Math.max(radiusModel.points[intervalIndex][1], radiusModel.points[intervalIndex + 1][1]);
    if (radius < lo - 1e-10 || radius > hi + 1e-10) outOfBoundsSamples++;
  }
  return {
    method: radiusModel.method,
    endpointCount: radiusModel.points.length,
    maxEndpointResidual_m: maxEndpointResidual,
    minRadius_m: minRadius,
    maxRadius_m: maxRadius,
    outOfBoundsSamples,
    fallbackIntervals: radiusModel.fallbackIntervals,
    dynamicFallbacks: radiusModel.dynamicFallbacks,
    endpointPass: maxEndpointResidual <= 1e-12,
    note: '端点零残差只验证了构造式的端点约束，不是未知时刻半径的独立预测验证。',
  };
}

function resultSummary(name, geometry, result) {
  const finalMoisture = result.endpointState?.moisture ?? result.finalMoisture;
  const finalTemperature = result.endpointState?.temperature ?? result.finalTemperature;
  const thresholdTime_s = result.thresholdEvent?.confirmedTime ?? null;
  return {
    caseName: name,
    geometry: geometry.method,
    n: result.grid.n,
    requestedDt_s: result.requestedDt,
    outputInterval_s: result.outputInterval,
    finalTime_s: result.balance.finalTime,
    finalTime_h: result.balance.finalTime / 3600,
    thresholdTime_s,
    thresholdTime_h: thresholdTime_s == null ? null : thresholdTime_s / 3600,
    thresholdEvent: result.thresholdEvent,
    finalRadius_m: result.finalRadius,
    finalCbar: 2 * result.grid.weights.reduce((sum, weight, i) => sum + weight * finalMoisture[i], 0),
    finalMaximumMoisture: Math.max(...finalMoisture),
    finalMaximumMoistureIndex: finalMoisture.indexOf(Math.max(...finalMoisture)),
    finalMinimumTemperature: Math.min(...finalTemperature),
    finalMaximumTemperature: Math.max(...finalTemperature),
    stageCrossings_s: result.stageCrossings,
    stageCrossings_h: Object.fromEntries(Object.entries(result.stageCrossings).map(([key, value]) => [key, value / 3600])),
    acceptedSteps: result.balance.acceptedSteps,
    rejectedSteps: result.balance.rejectedSteps,
    minAcceptedDt_s: result.balance.minAcceptedDt,
    maxAcceptedDt_s: result.balance.maxAcceptedDt,
    maxPicardIterations: result.balance.maxPicardIterations,
    maxPicardTemperatureResidual: result.balance.maxPicardTemperatureResidual,
    maxPicardMoistureResidual: result.balance.maxPicardMoistureResidual,
    moistureBalanceError: result.balance.moistureBalanceError,
    moistureBalanceErrorRelative: result.balance.moistureBalanceErrorRelative,
    thermalStorageBalanceError: result.balance.thermalStorageBalanceError,
    thermalStorageBalanceErrorRelative: result.balance.thermalStorageBalanceErrorRelative,
  };
}

function fieldCsv(result, field) {
  const header = ['time_s', 'radius_m', ...OUTPUT_RADII_M.map((value) => `${(value * 100).toFixed(1)}cm`), 'surface'];
  const records = result.store[field];
  return csv([header, ...result.store.times.map((time, i) => [time, result.store.radius[i], ...records[i], result.store[field === 'temperature' ? 'surfaceTemperature' : 'surfaceMoisture'][i]])]);
}

function table6(result) {
  const reportTimes = [0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72].map((hour) => hour * 3600);
  if (result.thresholdEvent) reportTimes.push(result.thresholdEvent.confirmedTime);
  reportTimes.sort((a, b) => a - b);
  const rows = [];
  for (const time of reportTimes) {
    const index = result.store.times.findIndex((value) => Math.abs(value - time) <= 1e-8);
    if (index < 0) continue;
    rows.push({ time, index });
  }
  const positions = [0, 5, 10, 15];
  const lines = ['# q4_final 表6', '', '单位：时间/h；空间列为物理半径/cm；域外留空；表面列为真实材料表面值。', '', '## 温度', '', '| 时间/h | 0.0 | 0.5 | 1.0 | 1.5 | 表面 |', '|---:|---:|---:|---:|---:|---:|'];
  for (const row of rows) lines.push(`| ${(row.time / 3600).toFixed(4)} | ${positions.map((position) => result.store.temperature[row.index][position] == null ? '' : result.store.temperature[row.index][position].toFixed(4)).join(' | ')} | ${result.store.surfaceTemperature[row.index].toFixed(4)} |`);
  lines.push('', '## 水分浓度', '', '| 时间/h | 0.0 | 0.5 | 1.0 | 1.5 | 表面 |', '|---:|---:|---:|---:|---:|---:|');
  for (const row of rows) lines.push(`| ${(row.time / 3600).toFixed(4)} | ${positions.map((position) => result.store.moisture[row.index][position] == null ? '' : result.store.moisture[row.index][position].toFixed(4)).join(' | ')} | ${result.store.surfaceMoisture[row.index].toFixed(4)} |`);
  return lines.join('\n');
}

function buildSubmissionWorkbook(result) {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('Sheet1');
  const header = ['时间\\到药材中心的距离', ...OUTPUT_RADII_M.map((value) => Number((value * 100).toFixed(1))), '药材表面'];
  const rows = [header, ...result.store.times.map((time, i) => [time, ...result.store.moisture[i], result.store.surfaceMoisture[i]])];
  sheet.showGridLines = false;
  sheet.getRangeByIndexes(0, 0, rows.length, rows[0].length).values = rows;
  sheet.getRangeByIndexes(0, 0, 1, rows[0].length).format = { fill: '#1F4E78', font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true };
  sheet.getRangeByIndexes(1, 0, rows.length - 1, 1).format.numberFormat = '0.000';
  sheet.getRangeByIndexes(1, 1, rows.length - 1, rows[0].length - 1).format.numberFormat = '0.0000';
  sheet.freezePanes.freezeRows(1);
  sheet.freezePanes.freezeColumns(1);
  workbook.recalculate();
  return workbook;
}

async function writeCaseArtifacts(runDir, config, inputs, geometry, result, caseName, referenceId) {
  const summary = resultSummary(caseName, geometry, result);
  const payload = {
    manifest: { kind: 'q4_final_case', caseName, referenceId, createdAt: new Date().toISOString() },
    fixed: { environmentWindowSeconds: inputs.environment.windowSeconds, environmentWindowMethod: inputs.environment.windowMethod, Ce: inputs.environment.lastWindowMean.moisture, threshold: THRESHOLD_C, mesh: config.main.mesh, physics: config.main.physics, coordinate: config.main.kind },
    geometry: { method: geometry.method, endpointResiduals: geometry.residuals, fallbackIntervals: geometry.fallbackIntervals, definition: geometry.geometryDefinition },
    summary,
    times_s: result.store.times,
    radius_m: result.store.radius,
    meanMoisture: result.store.meanMoisture,
    maximumMoisture: result.store.maximumMoisture,
    surfaceMoisture: result.store.surfaceMoisture,
    surfaceTemperature: result.store.surfaceTemperature,
    stageCrossings_s: result.stageCrossings,
    balance: result.balance,
  };
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'result_summary.json'), JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'final_state.json'), JSON.stringify({ time: result.lastState.time, radius: result.lastState.radius, thresholdEvent: result.thresholdEvent, temperature_C: result.lastState.temperature, moisture_kg_per_kg: result.lastState.moisture, coordinates: result.grid.coordinates, weights: result.grid.weights, edgeWidths: result.grid.edgeWidths }, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'state_checkpoints.json'), JSON.stringify({ coordinates: result.grid.coordinates, weights: result.grid.weights, edgeWidths: result.grid.edgeWidths, checkpoints: result.stateCheckpoints }, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'temperature_60s.csv'), fieldCsv(result, 'temperature'));
  await fs.writeFile(path.join(runDir, 'moisture_60s.csv'), fieldCsv(result, 'moisture'));
  await fs.writeFile(path.join(runDir, 'radius_time.csv'), csv([['time_s', 'radius_m'], ...result.store.times.map((time, i) => [time, result.store.radius[i]])]));
  await fs.writeFile(path.join(runDir, 'tables_6.md'), table6(result), 'utf8');
  await fs.writeFile(path.join(runDir, 'validation.md'), [
    '# q4_final 运行核查', '',
    `- 几何：${geometry.method}；参考进程：${referenceId}。`,
    `- N=${result.grid.n}；请求步长=${result.requestedDt}s；实际接受步长范围=${result.balance.minAcceptedDt}—${result.balance.maxAcceptedDt}s。`,
    `- 达标：${result.thresholdEvent ? JSON.stringify(result.thresholdEvent) : '72 h预算内未达标'}。`,
    `- 阶段时刻：${JSON.stringify(result.stageCrossings)}。`,
    `- 水分收支相对残差=${result.balance.moistureBalanceErrorRelative}；热收支相对残差=${result.balance.thermalStorageBalanceErrorRelative}。`,
    '- 物理半径输出每60 s保存；材料坐标上的完整终态和检查点单独保存。',
  ].join('\n'), 'utf8');
  if (config.outputs.writeXlsx) {
    const workbook = buildSubmissionWorkbook(result);
    const xlsx = await SpreadsheetFile.exportXlsx(workbook);
    await xlsx.save(path.join(runDir, 'result4_submission.xlsx'));
  }
  return summary;
}

function parseArgs(argv) {
  const args = { mode: 'all', config: defaultConfigPath, outputRoot: defaultOutputRoot };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, raw] = arg.slice(2).split('=', 2);
    const value = raw ?? 'true';
    if (key === 'mode') args.mode = value;
    else if (key === 'config') args.config = value;
    else if (key === 'output-root') args.outputRoot = value;
    else if (key === 'run-id') args.runId = value;
    else if (key === 'reference-file') args.referenceFile = value;
    else if (key === 'n') args.n = Number(value);
    else if (key === 'dt') args.dt = Number(value);
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!['reference', 'geometry', 'space', 'time', 'pchip', 'all'].includes(args.mode)) throw new Error(`未知模式: ${args.mode}`);
  return args;
}

async function readReference(referenceFile) {
  return JSON.parse(await fs.readFile(path.resolve(referenceFile), 'utf8'));
}

async function createRunDir(outputRoot, runId) {
  const runDir = path.join(path.resolve(outputRoot), runId);
  try {
    const existing = await fs.readdir(runDir);
    if (existing.length > 0) throw new Error(`运行目录非空，拒绝覆盖: ${runDir}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(runDir, { recursive: true });
  }
  return runDir;
}

async function runSpace(config, inputs, geometry, runDir, nValues = config.main.nValues, dt = config.main.dt_s) {
  const summaries = [];
  for (const n of nValues) {
    const caseName = `H_n${n}_dt${String(dt).replace('.', 'p')}`;
    console.log(`[q4-final] 开始 ${caseName}`);
    const caseDir = path.join(runDir, caseName);
    await fs.mkdir(caseDir, { recursive: true });
    const result = simulateQuestion4(inputs.environment, geometry, { n, dt, tEnd: config.main.tEnd_s, outputInterval: config.main.outputInterval_s, kind: config.main.kind, physics: config.main.physics, mesh: config.main.mesh, maxIterations: config.main.picardMaxIterations, progressPath: path.join(caseDir, 'progress.jsonl'), progressLabel: caseName, progressIntervalSeconds: 1800 });
    const summary = await writeCaseArtifacts(caseDir, config, inputs, geometry, result, caseName, 'reference_progress');
    summaries.push(summary);
    console.log(`[q4-final] 完成 ${caseName}: threshold=${summary.thresholdTime_h} h accepted=${summary.acceptedSteps} rejected=${summary.rejectedSteps}`);
  }
  await fs.writeFile(path.join(runDir, 'space_convergence.json'), JSON.stringify({ fixed: { dt_s: dt, nValues }, cases: summaries }, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'space_convergence.csv'), csv([
    ['case', 'N', 'dt_s', 'threshold_h', 'final_radius_m', 'final_max_C', 'accepted_steps', 'rejected_steps', 'min_dt_s', 'max_dt_s'],
    ...summaries.map((row) => [row.caseName, row.n, row.requestedDt_s, row.thresholdTime_h, row.finalRadius_m, row.finalMaximumMoisture, row.acceptedSteps, row.rejectedSteps, row.minAcceptedDt_s, row.maxAcceptedDt_s]),
  ]), 'utf8');
  return summaries;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.config);
  const inputs = await loadInputs(config.environment.windowSeconds);
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const runId = options.runId ?? `q4_final_${options.mode}_${stamp}`;
  const runDir = await createRunDir(options.outputRoot, runId);
  await fs.writeFile(path.join(runDir, 'config_used.json'), JSON.stringify(config, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'input_manifest.json'), JSON.stringify({ environmentInputPath, radiusInputPath, environmentWindow: inputs.environment, radiusPointCount: inputs.pchip.points.length, radiusLastTime_s: inputs.pchip.lastTime }, null, 2), 'utf8');
  const law = buildShrinkLaw(inputs.pchip, inputs.environment, config.shrinkage.p, config.shrinkage.tailCount);
  const referenceDir = options.mode === 'reference' ? runDir : path.join(runDir, 'reference_n160_dt2_72h');
  let referenceResult;
  if (options.mode === 'reference' || options.mode === 'all') referenceResult = await runReference(config, inputs, referenceDir);
  else referenceResult = { payload: await readReference(options.referenceFile ?? path.join(referenceDir, 'reference_progress.json')), law };
  const geometry = buildObservedProcessRadius(referenceResult.payload, inputs.pchip, config);
  const audit = auditGeometry(geometry, referenceResult.payload);
  await fs.writeFile(path.join(runDir, 'geometry_audit.json'), JSON.stringify(audit, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'geometry_radius_points.csv'), csv([
    ['time_s', 'observed_radius_m', 'reconstructed_radius_m', 'residual_m'],
    ...geometry.residuals.map((row) => [row.time, row.observed, row.fitted, row.residual]),
  ]), 'utf8');
  if (options.mode === 'reference' || options.mode === 'geometry') {
    console.log(JSON.stringify({ runDir, reference: referenceResult.payload.manifest, geometry: audit }, null, 2));
    return;
  }
  let spaceSummaries = [];
  if (options.mode === 'space' || options.mode === 'all') {
    spaceSummaries = await runSpace(config, inputs, geometry, path.join(runDir, 'space'), options.n ? [options.n] : config.main.nValues, options.dt ?? config.main.dt_s);
  }
  const selectedN = options.n ?? config.timeCheck.n;
  let timeSummaries = [];
  if ((options.mode === 'time' || options.mode === 'all') && config.timeCheck.enabled) {
    const timeDts = options.dt === undefined ? config.timeCheck.dtValues_s : [options.dt];
    for (const dt of timeDts) timeSummaries.push(...await runSpace(config, inputs, geometry, path.join(runDir, 'time'), [selectedN], dt));
  }
  let pchipSummary = null;
  if (options.mode === 'pchip' || options.mode === 'all') {
    const pchipName = `P_n${selectedN}_dt${String(options.dt ?? config.main.dt_s).replace('.', 'p')}`;
    const pchipDt = options.dt ?? config.main.dt_s;
    const pchipDir = path.join(runDir, 'pchip', pchipName);
    await fs.mkdir(pchipDir, { recursive: true });
    const result = simulateQuestion4(inputs.environment, inputs.pchip, { n: selectedN, dt: pchipDt, tEnd: config.main.tEnd_s, outputInterval: config.main.outputInterval_s, kind: config.main.kind, physics: config.main.physics, mesh: config.main.mesh, maxIterations: config.main.picardMaxIterations, progressPath: path.join(pchipDir, 'progress.jsonl'), progressLabel: pchipName, progressIntervalSeconds: 1800 });
    pchipSummary = await writeCaseArtifacts(pchipDir, config, inputs, inputs.pchip, result, pchipName, 'same_environment_direct_PCHIP');
  }
  if (spaceSummaries.length || timeSummaries.length || pchipSummary) {
    const hFinal = spaceSummaries.length ? spaceSummaries[spaceSummaries.length - 1] : null;
    await fs.writeFile(path.join(runDir, 'comparison_summary.json'), JSON.stringify({ H_space: spaceSummaries, H_time: timeSummaries, PCHIP: pchipSummary, selectedH: hFinal, notes: ['H为参考水分进程与实测端点约束的冻结半径几何重建；PCHIP为同环境、物性、网格和请求步长的几何对照。', '若最后两档或不同请求步长差异未满足方案目标，应保留差异，不人为选择更接近预期的结果。'] }, null, 2), 'utf8');
  }
  await fs.writeFile(path.join(runDir, 'run_manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), mode: options.mode, runId, reference: referenceResult.payload.manifest, geometryAudit: audit, notes: ['H为文献启发参考进程加实测端点约束的冻结半径几何重建；P为同环境、同物性、同网格和同请求步长的PCHIP对照。', 'H不是当前C场与R的完全双向耦合模型；其半径函数由参考水分进程和全部半径观测离线构造。'] }, null, 2), 'utf8');
  console.log(JSON.stringify({ runDir, mode: options.mode, geometryAudit: audit }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}

export { buildObservedProcessRadius, auditGeometry, loadInputs, runReference, runSpace };
