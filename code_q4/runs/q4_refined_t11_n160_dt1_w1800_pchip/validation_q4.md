# A题第四问验证记录

- 模式：full；对照：t11；环境延拓：lastWindowMean；窗口=1800 s；半径方法=pchip；坐标=material；物性=q4。
- N=160；网格=surfaceRefined；请求步长=1 s；输出间隔=60 s；实际终点=183876.9462890625 s；接受步=183877；回退步=0。
- 半径输入：145个点；原始范围0—259200 s；方法=pchip；区间外保持末观测值。
- 终点事件：{"bracket":[183876.9453125,183876.9462890625],"confirmedTime":183876.9462890625,"confirmedMaximum":0.14999999956701113,"confirmedIndex":0,"criterion":"max over all internal x nodes < 0.15 kg/kg"}。
- 终点半径：1.2 cm；阶段穿越：{"0.6":49632.65699557648,"0.3":82625.52652242519,"0.2":123983.13915767176,"0.15":183876.9462890625}。
- 水分收支差：-6.432635348829763e-7（相对-5.045204195160595e-7）；热收支差：-1.4573741033673286（相对-3.099334995492993e-8）；Picard最大轮数：15；最大尺度残差=9.999506969313773e-9/2.1083891259218574e-9。
- 守护测试：{"fixedRadiusTemperatureMaxDifference":6.039613253960852e-14,"fixedRadiusMoistureMaxDifference":9.769962616701378e-15,"closedUniformMaxChange":7.549516567451064e-15,"closedNonuniformRelativeIntegralError":1.1102230246251565e-16,"manufacturedTemperatureMaxError":0.000031343952034745826,"manufacturedMoistureMaxError":0.0000013217312377911128}。
- 四组对照：{"status":"single case complete","times_h":{"t00":null,"t10":null,"t01":null,"t11":51.07692952473958},"event_bracket_width_h":{"t11":2.712673611111111e-7},"interaction_h":null,"property_effect_h":null,"geometry_effect_h":null,"decomposition_check_h":null}。
- 正式模型在固定材料坐标x上推进，输出再按x=r/R(t)插值到物理半径；域外单元留空。
- 物性与几何效应按四组反事实轨迹的对称分摊报告，不把交互项重复相加。