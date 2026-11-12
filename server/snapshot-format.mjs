// 仅改变 MCP 输出表示，不改变浏览器采集、引用或动作。
export function compactSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.elements) || !snapshot.elements.length) return snapshot;
  const defaults = {};
  for (const key of Object.keys(snapshot.elements[0])) {
    if (!snapshot.elements.every(item => Object.hasOwn(item, key))) continue;
    const frequencies = new Map();
    for (const item of snapshot.elements) {
      const encoded = JSON.stringify(item[key]);
      frequencies.set(encoded, (frequencies.get(encoded) || 0) + 1);
    }
    const [encoded, count] = [...frequencies].sort((a, b) => b[1] - a[1])[0];
    if (count > snapshot.elements.length / 2) defaults[key] = JSON.parse(encoded);
  }
  const elements = snapshot.elements.map(item => Object.fromEntries(Object.entries(item)
    .filter(([key, value]) => !Object.hasOwn(defaults, key) || JSON.stringify(value) !== JSON.stringify(defaults[key]))));
  const compact = { ...snapshot, format: 'compact', elementDefaults: defaults,
    formatNote: '每个elements元素继承elementDefaults，元素自身字段覆盖默认值；全部ref、值、状态和coverage均保留。', elements };
  return Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(snapshot)) ? compact : snapshot;
}

// format 仅属于 MCP 输出选项，不能把新参数传给旧版本桥或扩展。
export function browserRequestParams(name, args) {
  if (name === 'browser_snapshot') {
    const { format, ...params } = args;
    return params;
  }
  if (name === 'browser_batch') return { ...args, commands: args.commands.map(command => ({ ...command,
    params: command.method === 'snapshot' ? browserRequestParams('browser_snapshot', command.params) : command.params })) };
  return args;
}
