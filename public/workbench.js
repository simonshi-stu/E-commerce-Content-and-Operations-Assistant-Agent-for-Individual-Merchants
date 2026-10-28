(() => {
  'use strict';
  const KEY = 'sourcing-workbench.projects.v1';
  const $ = (id) => document.getElementById(id);
  function read() {
    try { const value = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(value) ? value.filter((p) => p && typeof p.name === 'string' && typeof p.category === 'string' && typeof p.market === 'string').slice(0, 50) : []; }
    catch { return []; }
  }
  let projects = read();
  function element(tag, text, cls) { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; }
  function render() {
    const container = $('wb-project-list');
    container.replaceChildren();
    if (!projects.length) { container.append(element('div', '从一个品类开始。创建项目后，可带着相同简报进入研究和视频工作区；不会预填历史业务数据。', 'wb-empty')); return; }
    for (const project of projects) {
      const card = element('article', '', 'wb-project');
      card.append(element('span', project.category, 'wb-kicker'), element('h3', project.name), element('p', `${project.market} · 本地简报 · 未执行研究`));
      const params = new URLSearchParams({ project: project.name, category: project.category, market: project.market });
      const research = element('a', '开始研究 ↗'); research.href = `/reports.html?entry=track&${params}`;
      const video = element('a', '制作视频 ↗'); video.href = `/video.html?${params}`;
      const remove = element('button', '移除', 'quiet-button small'); remove.type = 'button';
      remove.addEventListener('click', () => {
        const next = projects.filter((p) => p.id !== project.id);
        try { localStorage.setItem(KEY, JSON.stringify(next)); projects = next; render(); } catch { $('wb-project-status').textContent = '本地存储不可用，未移除。'; }
      });
      card.append(research, video, remove); container.append(card);
    }
  }
  $('wb-project-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (projects.length >= 50) { $('wb-project-status').textContent = '最多保留 50 个本地项目，请先移除不需要的简报。'; return; }
    const name = $('wb-project-name').value.trim(), category = $('wb-project-category').value.trim(), market = $('wb-project-market').value.trim();
    if (!name || !category || !market) return;
    const next = [{ id: crypto.randomUUID(), name, category, market, createdAt: new Date().toISOString() }, ...projects];
    try { localStorage.setItem(KEY, JSON.stringify(next)); projects = next; render(); event.target.reset(); $('wb-project-status').textContent = '本地项目简报已保存。尚未访问外部数据源或创建外部业务任务。'; }
    catch { $('wb-project-status').textContent = '浏览器存储不可用，项目未保存。'; }
  });
  let theme = 'dark'; try { theme = localStorage.getItem('ecommerce-content-assistant-theme') || 'dark'; } catch { /* optional */ }
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  $('wb-theme').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('ecommerce-content-assistant-theme', next); } catch { /* optional */ } });
  render();
})();
