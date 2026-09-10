# A题第二问实现

本目录独立实现第二问的固定半径一维径向热湿耦合模型，不调用第一问求解器的状态或输出。

运行时使用工作区提供的 Node.js 和 `@oai/artifact-tool`：

```powershell
& 'C:\Users\ASUS\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'code_q2\solve_q2.mjs'
```

默认运行 `100 s` 调试算例、平衡/封闭边界测试和变系数制造解测试，结果写入新的 `outputs/q2/<运行编号>/`。长程计算通过参数显式开启：

```powershell
& '...\\node.exe' 'code_q2\\solve_q2.mjs' --mode=3h
& '...\\node.exe' 'code_q2\\solve_q2.mjs' --mode=full
```

第二问的正式输出、验证记录和图件不能写入第一问的 `code/` 或 `outputs/`。
