import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment, simulateQuestion2, diffusionCoefficient } from './solve_q2.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatePath = path.join(projectRoot, 'code_q2/runs/q2_3h_candidate_20260911/result2_internal.json');
const defaultRoot = path.join(projectRoot, 'code_q2/runs');
const R = 0.02;
const C0 = 2.55;
const T_REF_K = 301.15;
const D0 = diffusionCoefficient(C0, 28, { a: 1, b: 1 });
const CASES = ['M00', 'M10', 'M01', 'M11'];
const TIMES = [0, 1800, 3600, 5400, 7200, 9000, 10800];

function parseArgs(argv) {
  const args = { outputRoot: 'code_q2/runs', runId: 'q2_3h_analysis_20260911' };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=', 2);
    if (key === 'output-root') args.outputRoot = value;
    else if (key === 'run-id') args.runId = value;
    else throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

function mode(caseName) {
  return { a: Number(caseName[1]), b: Number(caseName[2]) };
}

function logContributions(temperature, moisture) {
  const temperatureK = temperature + 273.15;
  const aT = 3850 * (1 / T_REF_K - 1 / temperatureK);
  const aC = 0.45 * (1 / C0 - 1 / moisture);
  return { aT, aC, total: aT + aC, D: D0 * Math.exp(aT + aC) };
}

function maxAbs(values) {
  return Math.max(...values.map((value) => Math.abs(value)));
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function createRunDirectory(args) {
  const root = path.resolve(projectRoot, args.outputRoot);
  const runDir = path.join(root, args.runId);
  try {
    const entries = await fs.readdir(runDir);
    if (entries.length > 0) throw new Error(`分析运行目录非空，拒绝覆盖: ${runDir}`);
  } catch (error) {
    if (error.code === 'ENOENT') await fs.mkdir(runDir, { recursive: false });
    else throw error;
  }
  return { runDir, root };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { runDir, root } = await createRunDirectory(args);
  const environment = await loadEnvironment('lastValue');
  const started = Date.now();
  const comparisons = [];
  const trajectories = {};
  for (const caseName of CASES) {
    const result = simulateQuestion2(environment, {
      n: 320,
      dt: 0.125,
      tEnd: 10800,
      storeTimes: TIMES,
      diffusionMode: mode(caseName),
    });
    trajectories[caseName] = result.store;
    const last = result.store.times.length - 1;
    const meanMoisture3h = result.store.meanMoisture[last];
    const surfaceMoisture3h = result.store.surfaceMoisture[last];
    const centerMoisture3h = result.store.moisture[last][0];
    const yield3h = C0 - meanMoisture3h;
    comparisons.push({
      model: caseName,
      a: mode(caseName).a,
      b: mode(caseName).b,
      meanMoisture3h,
      surfaceMoisture3h,
      centerMoisture3h,
      centerSurfaceGap3h: centerMoisture3h - surfaceMoisture3h,
      moistureLoss3h: yield3h,
      acceptedSteps: result.balance.acceptedSteps,
      rejectedSteps: result.balance.rejectedSteps,
      moistureBalanceError: result.balance.moistureBalanceError,
      maxPicardIterations: result.balance.maxPicardIterations,
    });
  }
  const byModel = new Map(comparisons.map((row) => [row.model, row]));
  const interaction = byModel.get('M11').moistureLoss3h
    - byModel.get('M10').moistureLoss3h
    - byModel.get('M01').moistureLoss3h
    + byModel.get('M00').moistureLoss3h;
  const candidate = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
  const contributionRows = [];
  for (let i = 0; i < candidate.times.length; i++) {
    for (const radiusIndex of [0, 10, 20]) {
      const contribution = logContributions(candidate.temperature_C[i][radiusIndex], candidate.moisture_kg_per_kg[i][radiusIndex]);
      contributionRows.push({
        time_s: candidate.times[i],
        radius_cm: candidate.radii_m[radiusIndex] * 100,
        temperature_C: candidate.temperature_C[i][radiusIndex],
        moisture_kg_per_kg: candidate.moisture_kg_per_kg[i][radiusIndex],
        A_T: contribution.aT,
        A_C: contribution.aC,
        log_D_ratio: contribution.total,
        D_m2_per_s: contribution.D,
      });
    }
  }
  const rows = [
    ['model', 'a', 'b', 'mean_moisture_3h_kg_per_kg', 'surface_moisture_3h_kg_per_kg', 'center_moisture_3h_kg_per_kg', 'center_minus_surface_kg_per_kg', 'moisture_loss_3h', 'accepted_steps', 'rejected_steps', 'moisture_balance_error', 'max_picard_iterations'],
    ...comparisons.map((row) => [row.model, row.a, row.b, row.meanMoisture3h, row.surfaceMoisture3h, row.centerMoisture3h, row.centerSurfaceGap3h, row.moistureLoss3h, row.acceptedSteps, row.rejectedSteps, row.moistureBalanceError, row.maxPicardIterations]),
  ];
  await fs.writeFile(path.join(runDir, 'mechanism_comparison.csv'), rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n', 'utf8');
  await fs.writeFile(path.join(runDir, 'logD_contributions.csv'), [
    ['time_s', 'radius_cm', 'temperature_C', 'moisture_kg_per_kg', 'A_T', 'A_C', 'log_D_ratio', 'D_m2_per_s'],
    ...contributionRows.map((row) => [row.time_s, row.radius_cm, row.temperature_C, row.moisture_kg_per_kg, row.A_T, row.A_C, row.log_D_ratio, row.D_m2_per_s]),
  ].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n', 'utf8');
  await fs.writeFile(path.join(runDir, 'mechanism_analysis.json'), JSON.stringify({
    run: { createdAt: new Date().toISOString(), elapsedMs: Date.now() - started, projectRoot, root, tEnd: 10800, n: 320, dt: 0.125 },
    comparison: comparisons,
    interactionMoistureLoss3h: interaction,
    contributionDefinition: 'A_T=3850*(1/T_REF_K-1/T_K); A_C=0.45*(1/C0-1/C); log(D/D0)=A_T+A_C',
    contributionRows,
    notes: [
      '四组模型均独立求解 T、C，只有 D 的温度依赖和含水率依赖按 a,b 关闭。',
      '交互项只表示当前对照定义下的非加性指标，不是实验因果验证。',
      '贡献数据来自已完成的 M11 3 h 候选轨迹，展示半径为 0、1、2 cm。',
    ],
  }, null, 2), 'utf8');
  console.log(JSON.stringify({ runDir, comparisons, interactionMoistureLoss3h: interaction, contributionRows: contributionRows.length }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
