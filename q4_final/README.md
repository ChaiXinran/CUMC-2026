# 第四问最终方案代码（q4_final）

本目录按 `docs/A题_第四问_第一版完整方案_文献收缩与实测约束_20260912.md` 独立实现，暂不覆盖 `code_q4/` 与 `code_q4_shrink/` 的已有成果。

## 模型身份

- 参考进程：沿用已标定的 (p=2.075)、附录4物性、Robin边界和末段1800 s环境均值，生成72 h的密集 (
  \widehat C(t),\widehat{MR}(t),s(t)=\widehat{MR}(t)^p
  )；参考计算在达标后继续推进。
- H主模型：以附件2原始半径点为端点，用
  (R_H^2=(1-\theta)R_i^2+\theta R_{i+1}^2)，
  (	heta=(s(t)-s_i)/(s_{i+1}-s_i))重建未测时刻半径；无效参考区间才退回半径平方的时间线性插值。
- P对照：同一环境、物性、网格和请求时间步下的附件2 PCHIP半径。

H是“实测端点约束的离线几何重建”，不是当前C场自主更新R的完全双向耦合模型。文献仅提供收缩—含水率建模动机；p和端点约束由本题数据确定。

## 运行入口

在 `E:\数模2026\CUMC-2026` 执行；本目录运行会拒绝覆盖非空运行目录：

```text
node q4_final/solve_q4_final.mjs --mode=reference --run-id=reference_n160_dt2_72h
node q4_final/solve_q4_final.mjs --mode=geometry --run-id=geometry_audit --reference-file=q4_final/runs/reference_n160_dt2_72h/reference_progress.json
node q4_final/solve_q4_final.mjs --mode=all --run-id=full_v1
```

`all`依次生成参考进程、几何审计、H的N=160/320/640空间序列、N=640时间核查和同条件PCHIP对照。长程运行每1800 s模拟时间向参考进程的 `progress.jsonl` 输出一次；主模型每个案例结束后保存60 s场输出、终态和检查点。

## 主要输出

- `reference_progress.json/csv`：时间戳、平均含水率、MR和 (s=MR^p)。
- `geometry_audit.json`、`geometry_radius_points.csv`：端点残差、回退区间、半径范围与越界审计。
- `space/space_convergence.json/csv`：H的N收敛。
- 每个案例目录：`result_summary.json`、`temperature_60s.csv`、`moisture_60s.csv`、`radius_time.csv`、`final_state.json`、`state_checkpoints.json`、`tables_6.md`、`validation.md`。

运行结果尚未在本次代码提交中生成；本提交只包含可复现代码和固定配置。
