export const stateLabels = {
  todo: '待办',
  'in-progress': '进行中',
  blocked: '阻塞',
  'awaiting-review': '待审阅',
  'review-passed': '审阅通过',
  'awaiting-acceptance': '待验收',
  completed: '已完成',
  archived: '已封存',
} as const;
export const logTypeLabels = {
  progress: '进展',
  discovery: '发现',
  judgment: '判断',
  verification: '验证',
  problem: '问题',
  continuation: '接续',
} as const;
export const importanceLabels = { normal: '一般', important: '重要', critical: '关键' } as const;
export const historyLabels: Record<string, string> = {
  'phase-created': '建立期次',
  'phase-updated': '修改期次记录',
  'phase-opened': '用户开放期次',
  'phase-checklist-updated': '维护期次条件',
  'category-created': '定义票据类别',
  'ticket-created': '建立正式票据',
  'ticket-requirements-updated': '修订票据要求',
  'log-created': '追加工作Log',
  'log-metadata-updated': '整理Log',
  'checklist-updated': '更新Checklist结果',
  'checklist-condition-updated': '修订验收条件',
  'checklist-condition-added': '增加验收条件',
  'supervisor-task-created': '建立主管清单项',
  'supervisor-task-updated': '维护主管清单项',
  'management-note': '补充项目脉络',
  'material-domain-allocated': '按责任分配材料子域',
};
