export const ROLE_TEMPLATE_OPTIONS = [
  { id: 'supervisor', label: '主管（Supervisor）', role: 'supervisor', prompt: '负责理解目标、拆解任务、派发给专职 Bot、组织交叉审查并向用户汇总最终结果。' },
  { id: 'fullstack', label: '全栈 / 前端', role: 'fullstack', prompt: '负责界面与集成实现，交付可运行代码并附简短验证说明。' },
  { id: 'backend', label: '后端 / 架构', role: 'backend', prompt: '负责服务端设计、数据契约与 API 正确性，返回 file:line 引用。' },
  { id: 'reviewer', label: '代码审查（Reviewer）', role: 'reviewer', prompt: '只做审查、不改文件。逐条给出 file:line、复现场景与严重度（high/medium/low）。' },
  { id: 'qa', label: '测试 / QA', role: 'qa', prompt: '编写并运行测试，报告具体失败与复现步骤。' },
  { id: 'custom', label: '自定义', role: 'custom', prompt: '' },
] as const;
