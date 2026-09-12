import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import {
  C0,
  H_M,
  H_T,
  OUTPUT_RADII,
  R0,
  T0,
  THRESHOLD_C,
  loadEnvironment,
  makeConstantEnvironment,
  simulateQuestion3,
} from './solve_q3.mjs';

const DEFAULT_MAX_T = 72 * 3600;
const STAGE_THRESHOLDS = [0.6, 0.3, 0.2, 0.15];
const EXTENSION_NAME = 'last30MinMean';
const EXTENSION_WINDOW_S = 1800;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRootDefault = path.join(projectRoot, 'outputs', 'q3');

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

function uniformRadii(n) {
  return Array.from({ length: n + 1 }, (_, i) => R0 * i / n);
}

function sampleMean(points, start, end) {
  const selected = points.filter((point) => point[0] >= start && point[0] <= end);
  if (selected.length === 0) throw new Error('时间平均窗口内没有环境数据点');
  return selected.reduce((sum, point) => sum + point[1], 0) / selected.length;
}

function makeThirtyMinuteEnvironment(base) {
  const start = Math.max(0, base.lastTime - EXTENSION_WINDOW_S);
  const temperature = sampleMean(base.temperaturePoints, start, base.lastTime);
  const moisture = sampleMean(base.moisturePoints, start, base.lastTime);
  return {
    ...base,
    extension: EXTENSION_NAME,
    last30MinMean: { temperature, moisture, start, end: base.lastTime },
    temperature: (time) => time <= base.lastTime ? base.temperature(time) : temperature,
    moisture: (time) => time <= base.lastTime ? base.moisture(time) : moisture,
  };
}

async function loadInitialStateFromQ2Xlsx(inputPath, targetTime, n) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
  const temperatureValues = workbook.worksheets.getItemAt(0).getUsedRange(true).values;
  const moistureValues = workbook.worksheets.getItemAt(1).getUsedRange(true).values;
  const sourceRadii = temperatureValues[0].slice(1).map((value) => Number(value) / 100);
  const findState = (values, label) => {
    const rows = values.slice(1).filter((row) => row[0] !== null && row[0] !== undefined);
    const row = rows.find((candidate) => Math.abs(Number(candidate[0]) - targetTime) < 1e-8);
    if (!row) throw new Error(label + '未找到 t=' + targetTime + ' s 的状态行');
    return row.slice(1).map(Number);
  };
  const sourceTemperature = findState(temperatureValues, '温度表');
  const sourceMoisture = findState(moistureValues, '水分浓度表');
  if (sourceTemperature.length !== sourceRadii.length || sourceMoisture.length !== sourceRadii.length) {
    throw new Error('第二问状态列与半径列长度不一致');
  }
  const targetRadii = uniformRadii(n);
  return {
    time: targetTime,
    temperature: targetRadii.map((radius) => interpolateState(sourceRadii, sourceTemperature, radius)),
    moisture: targetRadii.map((radius) => interpolateState(sourceRadii, sourceMoisture, radius)),
    source: inputPath,
  };
}

function csv(rows) {
  return rows.map((row) => row.map((value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[,"\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }).join(',')).join('\n') + '\n';
}

function stageRows(result) {
  return STAGE_THRESHOLDS.map((threshold) => [
    String(threshold),
    result.stageCrossings[threshold] === undefined ? null : result.stageCrossings[threshold] / 3600,
    'h',
    threshold === THRESHOLD_C ? '二分回算后确认' : '步内线性定位',
  ]);
}

function buildWorkbook(result) {
  const workbook = Workbook.create();
  const summary = workbook.worksheets.add('终点摘要');
  const temperatureSheet = workbook.worksheets.add('温度');
  const moistureSheet = workbook.worksheets.add('水分浓度');
  const summaryRows = [
    ['A题第三问：30分钟时间平均延拓', '', '', ''],
    ['指标', '数值', '单位', '说明'],
    ['确认结束时刻', result.endpointState ? result.endpointState.time / 3600 : null, 'h', '确认 max(C)<0.15'],
    ['终止时全域最大含水率', result.endpointState ? Math.max(...result.endpointState.moisture) : Math.max(...result.finalMoisture), 'kg/kg', '未舍入值'],
    ['终点最大值位置', result.balance.thresholdEvent ? result.balance.thresholdEvent.confirmedIndex * result.grid.dr * 100 : null, 'cm', '内部网格节点'],
    ['环境延拓', EXTENSION_NAME, '', '4 h 后采用最后 30 min 时间平均'],
    ['阈值', THRESHOLD_C, 'kg/kg', '严格全域阈值'],
    ['末段下降斜率（60 s窗口）', result.slopeWindows[60] ?? null, 'kg/kg/s', 'Cmax差分估计'],
    ['水分收支差', result.balance.moistureBalanceError, 'm²·kg/kg', '固定半径归一化积分'],
    ['计算初始时刻', result.startTime / 3600, 'h', result.initialSource ? '由第二问结果场插值后继续' : '题设初始状态'],
    ['阶段', '时间/h', '单位', 'Cmax首次穿越估计'],
    ...stageRows(result),
  ];
  summary.showGridLines = false;
  summary.getRangeByIndexes(0, 0, summaryRows.length, 4).values = summaryRows;
  summary.getRange('A1:D1').merge();
  summary.getRange('A1:D1').format = { font: { name: 'Arial', size: 14, bold: true, color: '#1F1F1F' }, verticalAlignment: 'center' };
  summary.getRange('A2:D2').format = { fill: '#1F4E78', font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center', verticalAlignment: 'center' };
  summary.getRange('A11:D11').format = { fill: '#D9EAF7', font: { name: 'Arial', size: 10, bold: true, color: '#1F1F1F' }, horizontalAlignment: 'center' };
  summary.getRangeByIndexes(0, 0, summaryRows.length, 4).format.font = { name: 'Arial', size: 10, color: '#222222' };
  summary.getRange('A1:D1').format.font = { name: 'Arial', size: 14, bold: true, color: '#1F1F1F' };
  summary.getRangeByIndexes(2, 1, summaryRows.length - 2, 1).format.numberFormat = '0.000000';
  summary.getRangeByIndexes(0, 0, summaryRows.length, 4).format.verticalAlignment = 'center';
  summary.getRangeByIndexes(0, 0, summaryRows.length, 4).format.borders = { insideHorizontal: { style: 'thin', color: '#D9E2F3' }, bottom: { style: 'thin', color: '#A6A6A6' } };
  summary.getRange('A1:A15').format.columnWidth = 30;
  summary.getRange('B1:B15').format.columnWidth = 16;
  summary.getRange('C1:C15').format.columnWidth = 15;
  summary.getRange('D1:D15').format.columnWidth = 32;

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
    sheet.getRange('W1').values = [['A题第三问；30分钟时间平均延拓；单位：' + unit]];
    sheet.getRange('W1').format.font = { name: 'Arial', size: 10, italic: true, color: '#666666' };
    sheet.getRange('W1').format.columnWidth = 34;
  };
  writeDataSheet(temperatureSheet, rowsTemperature, '℃');
  writeDataSheet(moistureSheet, rowsMoisture, 'kg/kg');
  workbook.recalculate();
  return workbook;
}

function parseArgs(argv) {
  const args = { n: 1280, dt: 0.5, startTime: 3 * 3600, tEnd: DEFAULT_MAX_T, outputInterval: 60, mesh: 'uniform', extension: EXTENSION_NAME };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const parts = arg.slice(2).split('=', 2);
    const key = parts[0];
    const value = parts[1] ?? 'true';
    if (key === 'n') args.n = Number(value);
    else if (key === 'dt') args.dt = Number(value);
    else if (key === 'start-time') args.startTime = Number(value);
    else if (key === 't-end') args.tEnd = Number(value);
    else if (key === 'output-interval') args.outputInterval = Number(value);
    else if (key === 'mesh') args.mesh = value;
    else if (key === 'initial-xlsx') args.initialXlsx = value;
    else if (key === 'run-id') args.runId = value;
    else if (key === 'output-root') args.outputRoot = value;
    else if (key === 'no-xlsx') args.noXlsx = true;
    else throw new Error('未知参数: ' + arg);
  }
  if (!args.initialXlsx) throw new Error('必须指定 --initial-xlsx');
  if (!(args.tEnd > args.startTime)) throw new Error('t-end 必须大于 start-time');
  return args;
}

async function createRunDirectory(options) {
  const runId = options.runId ?? 'q3_30min_' + new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const outputRoot = options.outputRoot ? path.resolve(projectRoot, options.outputRoot) : outputRootDefault;
  const runDir = path.join(outputRoot, runId);
  try {
    const existing = await fs.readdir(runDir);
    if (existing.length > 0) throw new Error('运行目录非空，拒绝覆盖: ' + runDir);
  } catch (error) {
    if (error.code === 'ENOENT') await fs.mkdir(runDir, { recursive: true });
    else throw error;
  }
  return { runId, runDir, outputRoot };
}

function safeOptions(options) {
  const value = { ...options };
  delete value.initialTemperature;
  delete value.initialMoisture;
  return value;
}

async function writeArtifacts(runDir, environment, result, tests, options, elapsedMs) {
  const output = {
    run: { mode: 'full', extension: EXTENSION_NAME, elapsedMs, projectRoot, outputRoot: path.dirname(runDir) },
    parameters: { R0, H_T, H_M, T0, C0, threshold: THRESHOLD_C, n: result.grid.n, dt: result.requestedDt, dr: result.grid.dr, mesh: result.grid.mesh, outputInterval: result.outputInterval, startTime: result.startTime },
    initialState: { source: result.initialSource, time: result.startTime },
    environment: { extension: EXTENSION_NAME, lastTime: environment.lastTime, endpoint: environment.endpoint, last30MinMean: environment.last30MinMean, temperature: environment.temperaturePoints, moisture: environment.moisturePoints },
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
    balance: { ...result.balance, extension: EXTENSION_NAME },
    tests,
  };
  await fs.writeFile(path.join(runDir, 'result3_internal.json'), JSON.stringify(output, null, 2), 'utf8');
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
  await fs.writeFile(path.join(runDir, 'validation_q3_30min.md'), [
    '# A题第三问 30 分钟时间平均延拓验证记录', '',
    '- 环境延拓：4 h 后采用附件1最后 1800 s 的时间平均。',
    '- 时间平均窗口：' + environment.last30MinMean.start + ' s 至 ' + environment.last30MinMean.end + ' s。',
    '- 温度平均：' + environment.last30MinMean.temperature + ' ℃；含水率平均：' + environment.last30MinMean.moisture + ' kg/kg。',
    '- 网格：' + result.grid.mesh + '；N=' + result.grid.n + '；请求步长=' + result.requestedDt + ' s；输出间隔=' + result.outputInterval + ' s。',
    '- 计算起始：' + result.startTime + ' s；初始状态来源：' + result.initialSource + '。',
    '- 实际终点：' + result.balance.finalTime + ' s；终点事件：' + JSON.stringify(result.balance.thresholdEvent) + '。',
    '- 接受步：' + result.balance.acceptedSteps + '；回退步：' + result.balance.rejectedSteps + '；水分收支差：' + result.balance.moistureBalanceError + '。',
    '- 判断使用全部内部节点和未舍入含水率；工作簿数值格式仅用于显示。',
  ].join('\n'), 'utf8');
  const manifest = { runId: path.basename(runDir), createdAt: new Date().toISOString(), options: safeOptions(options), outputs: ['result3_internal.json', 'endpoint_localization.csv', 'stage_crossings.csv', 'validation_q3_30min.md', 'result3.xlsx'] };
  await fs.writeFile(path.join(runDir, 'run_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (!options.noXlsx) {
    const workbook = buildWorkbook(result);
    const preview = await workbook.render({ sheetName: '终点摘要', range: 'A1:D15', scale: 2, format: 'png' });
    await fs.writeFile(path.join(runDir, 'preview_summary.png'), new Uint8Array(await preview.arrayBuffer()));
    const summaryCheck = await workbook.inspect({ kind: 'table', range: '终点摘要!A1:D15', include: 'values,formulas', tableMaxRows: 20, tableMaxCols: 6 });
    await fs.writeFile(path.join(runDir, 'workbook_summary.inspect.ndjson'), summaryCheck.ndjson ?? JSON.stringify(summaryCheck), 'utf8');
    const errorCheck = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 300 }, summary: 'final formula error scan' });
    await fs.writeFile(path.join(runDir, 'workbook_errors.inspect.ndjson'), errorCheck.ndjson ?? JSON.stringify(errorCheck), 'utf8');
    const xlsx = await SpreadsheetFile.exportXlsx(workbook);
    await xlsx.save(path.join(runDir, 'result3.xlsx'));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { runId, runDir, outputRoot } = await createRunDirectory(options);
  const started = Date.now();
  const baseEnvironment = await loadEnvironment('lastValue');
  const environment = makeThirtyMinuteEnvironment(baseEnvironment);
  const initialPath = path.resolve(projectRoot, options.initialXlsx);
  const initial = await loadInitialStateFromQ2Xlsx(initialPath, options.startTime, options.n);
  options.initialTemperature = initial.temperature;
  options.initialMoisture = initial.moisture;
  options.initialSource = initial.source;
  const tests = {};
  const basic = simulateQuestion3(makeConstantEnvironment(T0, C0), { n: 16, dt: 1, tEnd: 20, outputInterval: 20, mesh: 'uniform' });
  tests.equilibriumTemperatureChange = Math.max(...basic.finalTemperature.map((value, i) => Math.abs(value - T0)));
  tests.equilibriumMoistureChange = Math.max(...basic.finalMoisture.map((value, i) => Math.abs(value - C0)));
  tests.acceptedSteps = basic.balance.acceptedSteps;
  const result = simulateQuestion3(environment, options);
  await writeArtifacts(runDir, environment, result, tests, options, Date.now() - started);
  console.log(JSON.stringify({ runId, runDir, outputRoot, finalTime: result.balance.finalTime, thresholdEvent: result.balance.thresholdEvent, last30MinMean: environment.last30MinMean, tests }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1].replaceAll('\\', '/')).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
