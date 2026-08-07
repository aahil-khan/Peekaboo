/**
 * /resources — attach real system state to a question.
 *
 * Every number here is measured at resolve() time via ctx.getSystemInfo().
 * An earlier build of this plugin returned hardcoded strings, which is worse
 * than useless in a context plugin: the model cannot tell invented telemetry
 * from the real thing, and neither can the person reading the answer.
 */

const ITEMS = [
  { id: 'cpu', title: 'CPU usage', subtitle: 'Utilisation, load average, core count', icon: 'cpu' },
  { id: 'memory', title: 'Memory usage', subtitle: 'RAM and swap', icon: 'memory' },
  { id: 'disk', title: 'Disk usage', subtitle: 'Mounted filesystems', icon: 'hard-drive' },
  { id: 'all', title: 'Everything', subtitle: 'CPU, memory and disk together', icon: 'server' },
];

const gib = (bytes) => (bytes / 1024 ** 3).toFixed(1);
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

function cpuFragment(info) {
  const lines = [
    `CPU usage: ${info.cpu.usage.toFixed(1)}%`,
    `Cores: ${info.cpu.cores}`,
  ];
  // Load average is meaningless on Windows; the backend sends null there.
  if (info.cpu.load_average) {
    const [one, five, fifteen] = info.cpu.load_average;
    lines.push(`Load average: ${one.toFixed(2)}, ${five.toFixed(2)}, ${fifteen.toFixed(2)}`);
  }
  if (info.cpu.brand) lines.push(`Model: ${info.cpu.brand}`);
  return { id: 'cpu', type: 'text/plain', label: 'CPU', content: lines.join('\n') };
}

function memoryFragment(info) {
  const m = info.memory;
  const lines = [
    `Memory: ${gib(m.used)} GiB / ${gib(m.total)} GiB (${pct(m.used, m.total)}%)`,
  ];
  if (m.swap_total > 0) {
    lines.push(`Swap: ${gib(m.swap_used)} GiB / ${gib(m.swap_total)} GiB (${pct(m.swap_used, m.swap_total)}%)`);
  } else {
    lines.push('Swap: none configured');
  }
  return { id: 'memory', type: 'text/plain', label: 'Memory', content: lines.join('\n') };
}

function diskFragment(info) {
  if (!info.disks.length) {
    return { id: 'disk', type: 'text/plain', label: 'Disk', content: 'No mounted filesystems reported.' };
  }
  const lines = info.disks.map((d) => {
    const used = d.total - d.available;
    return `${d.mount_point}: ${gib(used)} GiB / ${gib(d.total)} GiB (${pct(used, d.total)}%)`
      + `${d.file_system ? ` — ${d.file_system}` : ''}`;
  });
  return { id: 'disk', type: 'text/plain', label: 'Disk', content: lines.join('\n') };
}

export default {
  type: 'context',

  search: async (query) => {
    const q = query.trim().toLowerCase();
    if (!q) return ITEMS;
    return ITEMS.filter(
      (i) => i.title.toLowerCase().includes(q) || i.subtitle.toLowerCase().includes(q)
    );
  },

  resolve: async (itemId, ctx) => {
    const info = await ctx.getSystemInfo();
    const wanted = itemId === 'all' ? ['cpu', 'memory', 'disk'] : [itemId];
    const builders = { cpu: cpuFragment, memory: memoryFragment, disk: diskFragment };

    return wanted
      .map((id) => builders[id])
      .filter(Boolean)
      .map((build) => build(info));
  },
};
