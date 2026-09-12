# A题第四问最新代码与结果说明

更新时间：2026-09-12

本文档整理第四问当前版本的 PCHIP 主模型和含水率驱动收缩扩展模型，包括代码、配置、运行目录、结果文件和最终采用结论。

## 1. 最终提交口径

当前推荐提交 PCHIP 主模型：

 t* = 183876.946289 s = 51.076929525 h ≈ 51.0769 h。

对应配置：

- 附录4物性；
- 4 h 后使用附件1最后 1800 s 的梯形时间平均；
- 附件2原始半径点的 PCHIP 保形插值；
- 材料坐标 x = r / R(t)；
- 表层加密网格 N = 160；
- 请求时间步 Δt = 1 s；
- 全域未舍入 max(C) < 0.15 作为达标判据。

含水率驱动收缩模型已完成标定和验证，但 N = 160 到 N = 320 仍有约 11.05 s 的终点变化，因此暂不替换 PCHIP 主模型，也不重新生成扩展版 result4。

## 2. 代码目录和职责

### 2.1 PCHIP 主模型

主代码：

- [solve_q4_refined.mjs](../code_q4/solve_q4_refined.mjs)

该代码负责读取附件1、附件2，处理后期环境延拓，构造半径函数，求解第四问热质耦合模型，运行单组或四组对照，并导出工作簿、表6、内部状态和验证文件。

主要参数：

| 参数 | 作用 | 正式值 |
|---|---|---|
| --mode | full、rough、tests | full |
| --extension | lastValue 或 lastWindowMean | lastWindowMean |
| --environment-window | 末段平均窗口/s | 1800 |
| --radius-method | linear、pchip、weibull | pchip |
| --case | t00、t10、t01、t11 | t11 |
| --n | 材料坐标区间数 | 160 |
| --dt | 请求时间步/s | 1 |
| --mesh | 网格类型 | surfaceRefined |
| --four-cases | 是否运行四组对照 | 正式单组不启用 |
| --no-xlsx | 是否不导出工作簿 | 正式提交不启用 |

正式主模型命令：

~~~text
node code_q4/solve_q4_refined.mjs --mode=full --extension=lastWindowMean --environment-window=1800 --radius-method=pchip --case=t11 --n=160 --dt=1 --mesh=surfaceRefined --run-id=q4_refined_t11_n160_dt1_w1800_pchip
~~~

### 2.2 含水率驱动收缩扩展

独立代码和配置：

- [solve_q4_shrink_coupled.mjs](../code_q4_shrink/solve_q4_shrink_coupled.mjs)
- [shrink_coupled_config.json](../code_q4_shrink/shrink_coupled_config.json)
- [README.md](../code_q4_shrink/README.md)

该代码负责：

- 使用与 PCHIP 相同的环境、物性、Robin 系数和阈值；
- 在每个隐式时间步内联立迭代 T、C、平均含水率、MR 和 R；
- 用当前含水率场更新 R⁻² 和 R⁻¹；
- 对原始 1800 s 半径测点标定 p；
- 运行 PCHIP、p=1 和标定 p 的 A/B/C 比较；
- 保存收支、残差、半径一致性、接受/拒绝步和中途进度。

## 3. 共用物理和数值口径

附件1有 241 个环境点，覆盖 0—14400 s，间隔 60 s。4 h 以前使用原始环境分段线性插值，4 h 以后使用最后 1800 s 的梯形时间平均：

~~~text
T∞ = 50.0093333333 °C
C∞ = 0.0499875000
~~~

初值和几何参数：

~~~text
R0 = 0.02 m
T(x,0) = 28 °C
C(x,0) = 2.55
~~~

附录4物性：

~~~text
rho4(C) = 760 + 90 C
cp4(C) = 1850 + 2150 C / (1 + C)
k4(C) = 0.12 + 0.20 C / (1 + C)
D4(C,T) = 4.2e-4 exp[-0.30/C - 3850/(T+273.15)]
~~~

传热和传质 Robin 系数为 h = 25、hm = 8×10⁻⁷。令 r = xR(t)，在材料坐标中求解热方程和水分方程；内部有限体积使用 R⁻²，表面交换使用 R⁻¹。在当前干基含水率和材料网格随材料运动的假设下，不额外重复添加网格对流项或体积压缩源项。

空间网格为 surfaceRefined：

~~~text
x_i = 1 - (1 - i/N)^2
~~~

时间推进采用隐式有限体积和 Picard 迭代；失败时整体回退时间步。保存实际步长、接受/拒绝步数、残差、收支、终态和 6 h 检查点。事件二分只定位 max(C) < 0.15，不代表总时间误差等于事件括区宽度。

## 4. PCHIP 主模型

### 4.1 半径处理

附件2包含 145 个原始半径测点，间隔 1800 s。主模型使用单调保形 PCHIP：

- 通过原始观测点；
- 保持原始半径单调性；
- 避免普通三次样条过冲；
- 区间内直接在实际计算时刻评价；
- 区间外保持最后一个实测半径；
- 不把插值产生的每秒数据作为观测。

PCHIP 是实测几何的数值表示，不是新的收缩本构。

### 4.2 正式运行目录

[q4_refined_t11_n160_dt1_w1800_pchip](../code_q4/runs/q4_refined_t11_n160_dt1_w1800_pchip/)

目录内关键文件：

| 文件 | 说明 |
|---|---|
| result4.xlsx | 分析版第四问工作簿 |
| result4_submission.xlsx | 提交版工作簿 |
| final_state.json | 达标终态 |
| tables_6.md | 表6 |
| validation_q4.md | 参数、残差、收支和守护测试 |
| run_manifest.json | 运行配置和输出清单 |

### 4.3 正式结果

| 项目 | 结果 |
|---|---:|
| 达标时间/s | 183876.946289 |
| 达标时间/h | 51.076929525 |
| 终点半径 | 0.012000 m = 1.2000 cm |
| 未舍入最大含水率 | 0.149999999567 |
| 最大含水率位置 | 中心节点 |
| 水分收支相对误差 | -5.05×10⁻⁷ |
| 热收支相对误差 | -3.10×10⁻⁸ |
| Picard最大轮数 | 15 |
| 接受步/拒绝步 | 183877 / 0 |

阶段穿越时间：

| max(C) | 时间/h |
|---:|---:|
| 0.60 | 13.786849 |
| 0.30 | 22.951535 |
| 0.20 | 34.439761 |
| 0.15 | 51.076930 |

### 4.4 PCHIP 的数值核查

同一末段环境均值和 PCHIP 半径下：

| 网格 N | 请求步长/s | 达标时间/h |
|---:|---:|---:|
| 80 | 1 | 51.089283 |
| 160 | 2 | 51.077433 |
| 160 | 1 | 51.076930 |
| 160 | 0.5 | 51.077102 |
| 320 | 1 | 51.073599 |
| 320 | 0.5 | 51.073554 |
| 320 | 0.25 | 51.073818 |

空间离散仍造成约 12 s 的变化，因此 51.076930 h 是正式配置结果，不能把事件定位的小数位解释为总时长已经精确到小时小数点后四位。

输入敏感性：

| 改变项 | 达标时间/h |
|---|---:|
| PCHIP，最后1800 s梯形均值 | 51.076930 |
| 线性半径，最后1800 s梯形均值 | 51.080431 |
| Weibull半径，最后1800 s梯形均值 | 51.063900 |
| PCHIP，最后3600 s梯形均值 | 51.098479 |
| 旧末值保持 | 50.829257 |
| 旧版本最后1 h算术均值 | 51.097083 |

## 5. 含水率驱动收缩扩展模型

### 5.1 收缩关系

~~~text
R(t) = R0 × sqrt[ lambda + (1 - lambda) × MR(t)^p ]
MR(t) = [Cbar(t) - Ce] / [C0 - Ce]
Cbar(t) = 2 × integral from 0 to 1 of x C(x,t) dx
~~~

固定 Ce = C∞ = 0.0499875。附件2最后 5 个原始半径点的算术平均为：

~~~text
Rtail = 0.01198 m
lambda = (Rtail / R0)^2 = 0.358801
~~~

尾段点参与 Rtail 和 lambda 的确定，因此不作为完全独立的验证证据。

### 5.2 双向耦合

每个隐式时间步内：

1. 用当前迭代含水率场计算平均含水率；
2. 计算 MR 和新的 R；
3. 更新内部 R⁻² 和表面 R⁻¹；
4. 重新求解温度和含水率；
5. 检查温度、含水率、半径、方程残差和半径一致性；
6. 共同收敛后接受，否则整体回退时间步。

同时检查 MR 是否越界、固定控制体权重下的水分收支和实际接受步长。

### 5.3 标定结果

标定目录：

[q4_shrink_calibration_n80_dt4_w1800](../code_q4_shrink/runs/q4_shrink_calibration_n80_dt4_w1800/)

关键文件：

| 文件 | 说明 |
|---|---|
| calibration_summary.json | 所有候选 p 的训练/验证指标 |
| p_grid.csv | 粗、细网格目标函数 |
| radius_observations_and_predictions.csv | 原始半径、预测半径和残差 |
| environment_and_shrinkage.json | 环境和收缩参数 |
| run_manifest.json | 标定配置 |

搜索 p = 0.25、0.5、…、3，再以 0.025 步长细化；选择规则是训练集原始半径残差平方和最小。得到：

~~~text
p = 2.075
~~~

半径误差单位为 cm：

| 模型 | 训练 RMSE | 训练最大误差 | 验证 RMSE | 验证最大误差 |
|---|---:|---:|---:|---:|
| p = 1 | 0.0980 | 0.2467 | 0.1253 | 0.2471 |
| p = 2.075 | 0.0117 | 0.0545 | 0.0136 | 0.0316 |

验证集误差最低点约在 p = 1.90，但按预先规定的训练目标最小规则选择 p = 2.075，不根据干燥终点反向调参。

### 5.4 A/B/C 比较

比较目录：

[q4_shrink_compare_n160_dt1_w1800](../code_q4_shrink/runs/q4_shrink_compare_n160_dt1_w1800/)

关键文件：

| 文件 | 说明 |
|---|---|
| comparison_summary.json | A/B/C比较结果 |
| radius_observations_and_predictions.csv | 半径观测和预测 |
| radius_comparison.svg | 半径轨迹图 |
| moisture_comparison.svg | 含水率对比图 |

| 组别 | 模型 | 达标时间/h |
|---|---|---:|
| A | PCHIP实测半径基准 | 51.076930 |
| B | 含水率驱动，p = 1 | 57.069164 |
| C | 含水率驱动，p = 2.075 | 50.641254 |

相对于 PCHIP：

- p = 1 延长 5.992235 h；
- p = 2.075 缩短 0.435675 h，约 26.14 min。

### 5.5 扩展模型稳定性

核查目录：

[q4_shrink_verify_p2p075](../code_q4_shrink/runs/q4_shrink_verify_p2p075/)

| 网格/时间步/容差 | 达标时间/h | 接受步 | 拒绝步 |
|---|---:|---:|---:|
| N=80，dt=4 s | 50.654462 | 64,801 | 0 |
| N=80，dt=2 s | 50.653499 | 91,177 | 0 |
| N=160，dt=1 s | 50.641254 | 182,309 | 0 |
| N=160，dt=4 s | 50.642255 | 47,361 | 3,470 |
| N=80，dt=4 s，容差收紧10倍 | 50.654123 | 49,075 | 6,968 |
| N=320，dt=1 s | 50.638185 | 296,836 | 172,866 |

N=320 中途日志目录：

[q4_shrink_space_n320_dt1_p2p075_progress30m](../code_q4_shrink/runs/q4_shrink_space_n320_dt1_p2p075_progress30m/)

其中 space_refinement_n320_dt1.json 保存最终空间核查结果；中途进度日志和完整结论保留在本地运行目录，不纳入精简提交。

## 6. 提交和复核文件

### 6.1 正式提交文件

使用 PCHIP 正式运行目录中的：

- [result4_submission.xlsx](../code_q4/runs/q4_refined_t11_n160_dt1_w1800_pchip/result4_submission.xlsx)

分析版和核查文件：

- [result4.xlsx](../code_q4/runs/q4_refined_t11_n160_dt1_w1800_pchip/result4.xlsx)
- [tables_6.md](../code_q4/runs/q4_refined_t11_n160_dt1_w1800_pchip/tables_6.md)
- [validation_q4.md](../code_q4/runs/q4_refined_t11_n160_dt1_w1800_pchip/validation_q4.md)

### 6.2 扩展模型文件

扩展模型不替换 result4_submission.xlsx。仓库中保留的复核结果为：

- 标定：calibration_summary.json、p_grid.csv；
- A/B/C比较：comparison_summary.json、radius_observations_and_predictions.csv；
- 图表：radius_comparison.svg、moisture_comparison.svg；
- 稳定性：numerical_verification.json、space_refinement_n320_dt1.json。

每个候选 p 的完整内部 JSON、全量场状态和逐步进度日志仍保留在本地运行目录中，但不纳入本次精简提交。

## 7. 最终判断

PCHIP 主模型已经具备完整代码、正式运行、result4 工作簿、提交版工作簿、表6、内部状态和验证记录，当前正文推荐结果为 51.0769 h。

含水率驱动收缩模型完成了真正的 T、C、R 双向隐式耦合，并且 p = 2.075 对原始半径观测的拟合明显优于 p = 1。但其空间收敛尚不足以支持四位小时小数的正式主结果声明，因此保留为扩展分析。

文献表述统一为：“受收缩—含水率关系研究启发，并由本题半径观测标定”。不能称文献已经直接证明该公式和参数适用于本题，也不能将模拟含水率称为实测含水率。
