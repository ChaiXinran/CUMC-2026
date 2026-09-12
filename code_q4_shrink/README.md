# 第四问：实测半径约束的水分驱动收缩扩展

本目录是第四问PCHIP实测半径基准之外的独立扩展，不覆盖已有 `code_q4/` 结果。

## 文件

- `shrink_coupled_config.json`：环境窗口、物性、收缩关系、标定划分和数值容差。
- `solve_q4_shrink_coupled.mjs`：环境加载、双向隐式耦合、标定、比较和稳定性核查。
- `runs/q4_shrink_calibration_n80_dt4_w1800/`：原始1800 s半径测点的粗/细网格标定与验证。
- `runs/q4_shrink_compare_n160_dt1_w1800/`：PCHIP、p=1和标定p的同条件比较、图表及完整状态。
- `runs/q4_shrink_verify_p2p075/`：空间、时间步和非线性容差核查。
- `runs/q4_shrink_space_n320_dt1_p2p075_progress30m/`：N=320空间加密重跑，包含中途 `progress.jsonl`。

## 运行方式

在项目根目录 `E:\数模2026\CUMC-2026` 执行：

```text
node code_q4_shrink/solve_q4_shrink_coupled.mjs --mode=tests
node code_q4_shrink/solve_q4_shrink_coupled.mjs --mode=calibrate --run-id=q4_shrink_calibration_n80_dt4_w1800 --resume=true
node code_q4_shrink/solve_q4_shrink_coupled.mjs --mode=compare --run-id=q4_shrink_compare_n160_dt1_w1800 --calibration-run=code_q4_shrink/runs/q4_shrink_calibration_n80_dt4_w1800
node code_q4_shrink/solve_q4_shrink_coupled.mjs --mode=verify --run-id=q4_shrink_verify_p2p075 --calibration-run=code_q4_shrink/runs/q4_shrink_calibration_n80_dt4_w1800 --comparison-run=code_q4_shrink/runs/q4_shrink_compare_n160_dt1_w1800
node code_q4_shrink/solve_q4_shrink_coupled.mjs --mode=space --run-id=q4_shrink_space_n320_dt1_p2p075_progress30m --calibration-run=code_q4_shrink/runs/q4_shrink_calibration_n80_dt4_w1800
```

`--mode=space` 每1800 s模拟时间向终端输出一条进度，并追加到该运行目录的 `progress.jsonl`。每条记录包括模拟时间、接受/拒绝步数、半径、平均含水率、最大含水率、外层/内层迭代次数和残差；如果长时间没有新记录，可据此检查是否需要停止。

标定过程不把插值生成的每秒数据当作独立观测；每个候选p都重新运行双向耦合模型。`Ce` 沿用Robin闭合下的末段环境含水率，`lambda` 由附件2最后5个原始半径点的算术平均固定得到，不能在标定中再次自由调整。

文献表述统一为“受收缩—含水率关系研究启发，并由本题半径观测标定”。不要把公式和参数写成文献已经直接证明适用于本题，也不要将模拟含水率称为实测数据。
