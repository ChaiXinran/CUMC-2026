# A题第一问实现

本目录实现《A题_第一问_方案评审与实施方案.md》中的中部横截面一维径向模型：温度场与水分场解耦，中心、内部和表面统一采用守恒有限体积，全隐式推进；水分场保留 `D(C)` 并使用阻尼 Picard 迭代。

运行主程序：

```powershell
& 'C:\Users\ASUS\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'code\solve_q1.mjs'
```

主程序读取 `CUMCM2026Problems/A题/附件/附件1.xlsx`，运行平衡、封闭边界、Bessel 基准、空间/时间收敛和常扩散对照，并在 `outputs/` 生成：

- `result1.xlsx`：温度和水分浓度完整结果；
- `tables_1_2.md`：论文表 1、表 2 的七个时刻和五个半径结果；
- `validation_report.md`：实际运行证据、收支、基准、收敛和局限；
- `result1_internal.json`：未按四位小数截断的输出网格数据；
- `*.svg`：由实际结果生成的曲线、径向剖面和收敛图。

开始或继续工作前，先阅读工作区根目录的 `AGENTS.md` 和方案评审文档。
