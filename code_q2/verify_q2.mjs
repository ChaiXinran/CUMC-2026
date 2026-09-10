import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment, simulateQuestion2 } from './solve_q2.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(projectRoot, 'code_q2/runs/q2_3h_candidate_20260911/result2_internal.json');
const CHECK_TIMES = [0, 1800, 3600, 5400, 7200, 9000, 10800];

function parseArgs(argv) {
  const args = { outputRoot: 'code_q2/runs', runId: 'q2_3h_convergence_20260911' };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=', 2);
    if (key === 'output-root') args.outputRoot = value;
    else if (key === 'run-id') args.runId = value;
    else throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

async function createRunDirectory(args) {
  const root = path.resolve(projectRoot, args.outputRoot);
  const runDir = path.join(root, args.runId);
  try {
    const entries = await fs.readdir(runDir);
    if (entries.length > 0) throw new Error(`收敛运行目录非空，拒绝覆盖: ${runDir}`);
  } catch (error) {
    if (error.code === 'ENOENT') await fs.mkdir(runDir, { recursive: false });
    else throw error;
  }
  return { root, runDir };
}

function compareSeries(reference, candidate, candidateTimes, fieldName, valueLabel) {
  const candidateByTime = new Map(candidateTimes.map((time, i) => [time, i]));
  let best = { value: -Infinity, time_s: null, radius_cm: null };
  let maxMean = 0;
  for (const time of candidateTimes) {
    const baseIndex = reference.times.indexOf(time);
    const candidateIndex = candidateByTime.get(time);
    if (baseIndex < 0 || candidateIndex === undefined) throw new Error(`比较时刻缺失: ${time}`);
    const baseValues = reference[fieldName][baseIndex];
    const candidateValues = candidate[fieldName][candidateIndex];
    for (let i = 0; i < baseValues.length; i++) {
      const difference = Math.abs(baseValues[i] - candidateValues[i]);
      if (difference > best.value) best = { value: difference, time_s: time, radius_cm: Number((reference.radii_m[i] * 100).toFixed(1)) };
    }
    if (fieldName === 'temperature_C') {
      maxMean = Math.max(maxMean, Math.abs(reference.volume_mean_temperature_C[baseIndex] - candidateMeanTemperature(candidate, candidateIndex)));
    } else {
      maxMean = Math.max(maxMean, Math.abs(reference.volume_mean_moisture_kg_per_kg[baseIndex] - candidateMeanMoisture(candidate, candidateIndex)));
    }
  }
  return { valueLabel, maxFieldDifference: best, maxMeanDifference: maxMean };
}

function candidateMeanTemperature(candidate, index) {
  return candidate.meanTemperature[index];
}

function candidateMeanMoisture(candidate, index) {
  return candidate.meanMoisture[index];
}

function compareResultStores(reference, result, label) {
  return {
    label,
    temperature: compareSeries(reference, {
      times: result.store.times,
      radii_m: reference.radii_m,
      temperature_C: result.store.temperature,
      meanTemperature: result.store.meanTemperature,
      meanMoisture: result.store.meanMoisture,
      volume_mean_temperature_C: reference.volume_mean_temperature_C,
      volume_mean_moisture_kg_per_kg: reference.volume_mean_moisture_kg_per_kg,
    }, result.store.times, 'temperature_C', '℃'),
    moisture: compareSeries(reference, {
      times: result.store.times,
      radii_m: reference.radii_m,
      moisture_kg_per_kg: result.store.moisture,
      meanTemperature: result.store.meanTemperature,
      meanMoisture: result.store.meanMoisture,
      volume_mean_temperature_C: reference.volume_mean_temperature_C,
      volume_mean_moisture_kg_per_kg: reference.volume_mean_moisture_kg_per_kg,
    }, result.store.times, 'moisture_kg_per_kg', 'kg/kg'),
  };
}

function compareShortRuns(reference, candidate) {
  const maxTemperature = Math.max(...reference.store.temperature[1].map((value, i) => Math.abs(value - candidate.store.temperature[1][i])));
  const maxMoisture = Math.max(...reference.store.moisture[1].map((value, i) => Math.abs(value - candidate.store.moisture[1][i])));
  return { maxTemperatureDifference: maxTemperature, maxMoistureDifference: maxMoisture };
}

function reportMarkdown(data) {
  const lines = [
    '# A题第二问收敛检查',
    '',
    '本文件只记录当前候选轨迹与独立分辨率/迭代容差对照，不把差异自动解释为四位小数已可靠。',
    '',
    '## 3 h 输出点对照',
    '',
    '| 对照 | 最大温度场差 / ℃ | 出现时刻/s | 出现半径/cm | 最大平均温度差 / ℃ | 最大水分场差 / kg/kg | 出现时刻/s | 出现半径/cm | 最大平均水分差 / kg/kg |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of data.threeHour) {
    const t = row.temperature.maxFieldDifference;
    const c = row.moisture.maxFieldDifference;
    lines.push(`| ${row.label} | ${t.value.toExponential(6)} | ${t.time_s} | ${t.radius_cm} | ${row.temperature.maxMeanDifference.toExponential(6)} | ${c.value.toExponential(6)} | ${c.time_s} | ${c.radius_cm} | ${row.moisture.maxMeanDifference.toExponential(6)} |`);
  }
  lines.push(
    '',
    '## 100 s 迭代容差对照',
    '',
    `- 正常容差与收紧容差的最大温度场差：${data.iterationTolerance.maxTemperatureDifference.toExponential(6)} ℃。`,
    `- 正常容差与收紧容差的最大含水率场差：${data.iterationTolerance.maxMoistureDifference.toExponential(6)} kg/kg。`,
    '',
    '## 判读',
    '',
    '- 空间与时间差异应与规定表格的四舍五入阈值分别比较，不能只看 Excel 显示格式。',
    '- 早期边界层会放大空间差异；若目标半径的差异仍不可接受，应继续加密或采用经验证的表面加密网格。',
    '- 迭代容差对照只检验非线性迭代误差，不替代空间和时间离散误差检验。',
  );
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { root, runDir } = await createRunDirectory(args);
  const started = Date.now();
  const environment = await loadEnvironment('lastValue');
  const reference = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
  const common = { tEnd: 10800, storeTimes: CHECK_TIMES, diffusionMode: { a: 1, b: 1 } };
  const spatial = simulateQuestion2(environment, { ...common, n: 160, dt: 0.125 });
  const temporal = simulateQuestion2(environment, { ...common, n: 320, dt: 0.25 });
  const spatialFine = simulateQuestion2(environment, { ...common, n: 640, dt: 0.125 });
  const temporalFine = simulateQuestion2(environment, { ...common, n: 320, dt: 0.0625 });
  const normalShort = simulateQuestion2(environment, { n: 80, dt: 0.25, tEnd: 100, storeTimes: [0, 100], diffusionMode: { a: 1, b: 1 } });
  const tightShort = simulateQuestion2(environment, {
    n: 80,
    dt: 0.25,
    tEnd: 100,
    storeTimes: [0, 100],
    diffusionMode: { a: 1, b: 1 },
    temperatureUpdateTolerance: 1e-10,
    moistureUpdateTolerance: 1e-12,
    residualTolerance: 1e-10,
  });
  const data = {
    run: { createdAt: new Date().toISOString(), elapsedMs: Date.now() - started, projectRoot, root, baselinePath, n: 320, dt: 0.125 },
    threeHour: [
      compareResultStores(reference, spatial, 'N=160, dt=0.125 对 N=320, dt=0.125'),
      compareResultStores(reference, temporal, 'N=320, dt=0.25 对 N=320, dt=0.125'),
      compareResultStores(reference, spatialFine, 'N=640, dt=0.125 对 N=320, dt=0.125'),
      compareResultStores(reference, temporalFine, 'N=320, dt=0.0625 对 N=320, dt=0.125'),
    ],
    iterationTolerance: compareShortRuns(normalShort, tightShort),
    balances: {
      baseline: reference.balance,
      spatial: spatial.balance,
      temporal: temporal.balance,
      spatialFine: spatialFine.balance,
      temporalFine: temporalFine.balance,
      normalShort: normalShort.balance,
      tightShort: tightShort.balance,
    },
  };
  await fs.writeFile(path.join(runDir, 'convergence_q2.json'), JSON.stringify(data, null, 2), 'utf8');
  await fs.writeFile(path.join(runDir, 'convergence_q2.md'), reportMarkdown(data), 'utf8');
  console.log(JSON.stringify({ runDir, elapsedMs: Date.now() - started, threeHour: data.threeHour, iterationTolerance: data.iterationTolerance }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
