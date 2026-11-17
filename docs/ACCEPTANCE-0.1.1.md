# 0.1.1 修复与验收台账

> 历史验收记录：许可、提交和发布状态为验收当时情况；当前许可见仓库 LICENSE，发布状态见 GitHub Releases 与 npm 注册表。

日期：2026-11-17（Asia/Shanghai）。范围：上一轮审查确认问题、可靠性与测试/CI打包门禁；不包含变量观察、异常采集、调试模板、自动改源码等新增功能路线。没有提交、推送、标签、发布或日常 DSH 安装。

## 修复项与验收依据

| 问题                            | 修复                                                                        | 回归依据                                  |
| ------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| terminal save失败吞错且丢任务   | 独立persistence状态与outcome、内存终态保留、锁连接、不重放                  | core-recovery保存故障注入                 |
| cwd变更旧任务无法取消           | 每步授权重验；同session旧cwd只读/取消恢复；失效路径也能恢复                 | core/host recovery                        |
| execute丢响应或面板remount丢ID  | requestId去重、listJobs分页、可订阅store和sessionStorage相关标识            | React renderer真实effect/reconciler测试   |
| 同request迟到响应覆盖更新结果   | 初始提交快照CAS，恢复结果不被降级                                           | recovered persistence_failed再迟到running |
| 磁盘列表离线阻断内存恢复        | storageUnavailable/incomplete警告并返回本session内存结果                    | save/list EIO故障注入                     |
| stdin EPIPE事件未消费           | child与全部stdio独立error监听，幂等清理、等待close、超时明确失败            | transport故障注入                         |
| PS参数大小写碰撞且启动无保护    | BridgePath/bridgeProcess分离，创建纳入finally                               | 无VS参数/启动结构测试                     |
| 断点创建后观察失败丢ID          | opaque创建归属及只读owned列表恢复，bound未知不重复Add                       | C#伪COM harness                           |
| 清理同名/当前status误杀与漏清理 | 精确PID/创建身份及本次子进程谱系，清理失败NOT PASS                          | ownership ledger与reparent回归            |
| 任意break被当step成功           | marker/function/source验证，实际位置推进和删除后置查询                      | smoke evidence反例                        |
| bridge二进制与build脚本漏指纹   | 精确生成目录排除，完整publish文件SHA256/size清单                            | changed/missing/extra负例                 |
| runtime许可缺失                 | 精确运行时pack许可证和notices复制/比对                                      | 许可缺失/伪造负例                         |
| required归档内容漏验            | package/cordis/许可/docs/locale/dist逐文件一致，tar类型/path校验            | 归档缺失/陈旧/危险路径负例                |
| CI可跳过必需SDK/桥接测试        | 固定rc.3 dev依赖、本地registry必需；bridge存在门禁、ProtocolSmoke和协议回归 | Plan A静态策略+固定SDK注册                |

## 环境与验证边界

Windows x64；本地隔离Node22.23.5和.NET SDK8.0.428；Visual Studio2022是外部工具。修复测试包含假桥接/假存储、真实React renderer、无VS子进程协议、伪COM C# harness。它们不等同真实VS所有引擎或当前DSH GUI安装验收。React renderer的deprecated提示不视为验收失败，也不隐藏。

旧[0.1.0记录](ACCEPTANCE-0.1.0.md)保留历史事实；当前严格实机脚本不以旧日志充当通过证据。源码位置若仍为null则not_verified，不得放宽断言使其通过。非本地或进程身份不可证明时明确拒绝，不为通过测试降低所有权门禁。

## 交付策略

方案A保持：仅版本标签v\*和手动触发；无普通push/PR/schedule。版本0.1.1候选输出到.artifacts/0.1.1，保留旧0.1.0归档。运行时许可进入候选；项目自身许可仍为UNLICENSED，未擅自选择公开许可。完整证据快照不随包上传。

## 真实 C++ 严格验收（2026-11-17）

最终独立新建VS PID27516，使用全新build-final011解决方案：marker精确命中main.cpp第10行、顶部Add函数、3线程8帧；step后源位置为第11行；自有断点删除后listOwnedBreakpoints为空；disconnect和精确归属进程清理完成。严格脚本exit0，PASS只在清理核验后输出。C#和扩展continue/pause/attach/terminate/evaluate不因此冒充已实测通过。

中间失败均明确exit1并清理：载入BUSY、重复历史断点返回空创建集合、默认IDispatch的类型库错误、SDK类型嵌入不支持与运行时引用问题。最终使用固定官方完整COM定义，运行时从Program Files下已安装VS2022 PublicAssemblies解析，不在候选中分发受限SDK DLL；校验名称/版本/文化/public-key token是程序集身份匹配，不是文件签名真实性证明。非标准安装路径目前不在解析列表，缺依赖明确失败。

GitHub远程CI和当前DSH GUI安装未执行，未重启日常DSH。最终命令统计与候选SHA256在.artifacts/0.1.1交付清单中保存。
