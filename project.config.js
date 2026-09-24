module.exports = {
  port: 3912,
  title: '钟乳石洞穴微环境巡测',
  lede: '围绕洞穴、分区、样点和巡测路线记录微环境数据，发现异常后进入处置台完成派单、改派与复查闭环。',
  // 样点基准的允许偏差：复查值需落在 基准值 ± 偏差 内。基准按样点维护，这里只定容差。
  tolerances: {
    temp: 1.0,        // ℃
    humidity: 5,      // 个百分点
    co2: 150          // ppm
  },
  // 值班负责人：与当前处置人一样，有权提交复查。
  dutyLeads: ['值班负责人', '陆班'],
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '重点保护': 'warn',
    '待派单': 'bad',
    '处理中': 'warn',
    '复查退回': 'bad',
    '异常待复查': 'bad',
    '暂停开放': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '重点保护', collection: 'sites', filter: { field: 'protectedStatus', value: '重点保护' } },
    { label: '巡测记录', collection: 'surveys' },
    { label: '处置中', collection: 'surveys', filter: { field: 'status', value: '处理中' } },
    { label: '复查退回', collection: 'surveys', filter: { field: 'status', value: '复查退回' } },
    { label: '待派单', collection: 'surveys', filter: { field: 'status', value: '待派单' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '趋势看板',
      type: 'dashboard',
      focusTitle: '异常与复查',
      focus: { collection: 'surveys', field: 'status', values: ['待派单', '处理中', '复查退回'], limit: 8 }
    },
    {
      id: 'console',
      label: '处置台',
      type: 'console',
      listTitle: '异常处置列表'
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准温度', name: 'baselineTemp', type: 'number', required: true },
        { label: '基准湿度', name: 'baselineHumidity', type: 'number', required: true },
        { label: '基准CO2', name: 'baselineCo2', type: 'number', required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测记录',
      collection: 'surveys',
      formTitle: '登记巡测',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、干扰痕迹、处置人',
      searchFields: ['surveyor', 'disturbance', 'photoUrl', 'assignee'],
      statusField: 'status',
      statusOptions: ['正常', '待派单', '处理中', '复查退回', '已复查'],
      titleFields: ['surveyor', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['disturbance', 'assignee'],
      detailFields: [
        { label: '温度', name: 'temperature' },
        { label: '湿度', name: 'humidity' },
        { label: 'CO2', name: 'co2' },
        { label: '处置人', name: 'assignee' },
        { label: '复查期限', name: 'reviewDueAt' }
      ],
      defaults: { status: '正常', reviewNote: '' },
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '温度', name: 'temperature', type: 'number', required: true },
        { label: '湿度', name: 'humidity', type: 'number', required: true },
        { label: 'CO2', name: 'co2', type: 'number', required: true },
        { label: '滴水频率', name: 'dripRate', type: 'number', required: true },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    }
  ],
  actions: [
    { id: 'site-normal', label: '常规观察', collection: 'sites', patches: [{ field: 'protectedStatus', value: '常规观察' }] },
    { id: 'site-focus', label: '重点保护', collection: 'sites', patches: [{ field: 'protectedStatus', value: '重点保护' }] },
    { id: 'site-close', label: '暂停开放', collection: 'sites', danger: true, patches: [{ field: 'protectedStatus', value: '暂停开放' }] },
    {
      id: 'survey-alert',
      label: '标记异常',
      collection: 'surveys',
      command: 'alert',
      relation: { collection: 'sites', localKey: 'siteId' },
      patches: [
        { field: 'status', value: '待派单' },
        { target: 'related', field: 'protectedStatus', value: '重点保护' }
      ]
    }
    // 派单 / 改派 / 复查提交走处置台专用命令（/api/console/...），规则在 lib/rules.js，
    // 不再提供一键“完成复查”，防止未经三项比对直接置为已复查。
  ],
  // 处置台表单描述（仅页面结构；判定规则与权限在 lib/rules.js）。
  consoleForms: {
    dispatch: {
      title: '派单处置',
      submitLabel: '确认派单',
      fields: [
        { label: '处置人', name: 'assignee', type: 'staff', required: true },
        { label: '复查期限', name: 'reviewDueAt', type: 'date', required: true },
        { label: '派单说明', name: 'note', type: 'textarea', wide: true }
      ]
    },
    reassign: {
      title: '改派处置人',
      submitLabel: '确认改派',
      fields: [
        { label: '新处置人', name: 'assignee', type: 'staff', required: true },
        { label: '改派原因', name: 'reason', type: 'textarea', required: true, wide: true }
      ]
    },
    submit: {
      title: '提交复查',
      submitLabel: '提交复查判定',
      hint: '温度、湿度、CO2 三项均需在样点基准允许范围内，任一项超出将退回并保留数据。',
      fields: [
        { label: '提交人', name: 'submitter', type: 'staff', required: true, help: '须为当前处置人或值班负责人' },
        { label: '复查温度(℃)', name: 'temperature', type: 'number', step: 0.1, required: true },
        { label: '复查湿度(%)', name: 'humidity', type: 'number', step: 0.1, required: true },
        { label: '复查CO2(ppm)', name: 'co2', type: 'number', step: 1, required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    baseline: {
      title: '调整样点基准',
      submitLabel: '保存并重新判定',
      hint: '保存后，所有未完成复查将按新范围重新判定。',
      fields: [
        { label: '基准温度(℃)', name: 'baselineTemp', type: 'number', step: 0.1, required: true },
        { label: '基准湿度(%)', name: 'baselineHumidity', type: 'number', step: 0.1, required: true },
        { label: '基准CO2(ppm)', name: 'baselineCo2', type: 'number', step: 1, required: true },
        { label: '调整原因', name: 'reason', type: 'textarea', required: true, wide: true }
      ]
    }
  }
};
