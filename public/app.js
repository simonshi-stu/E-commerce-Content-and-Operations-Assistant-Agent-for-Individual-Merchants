(() => {
  'use strict';

  const form = document.querySelector('#generator-form');
  const status = document.querySelector('#status');
  const submitButton = document.querySelector('#submit-button');
  const resultSection = document.querySelector('#result-section');
  const results = document.querySelector('#results');
  const copyAll = document.querySelector('#copy-all');
  const historySection = document.querySelector('#history-section');
  const historyList = document.querySelector('#history-list');
  const clearHistory = document.querySelector('#clear-history');
  const historyKey = 'ecommerce-content-demo-history-v1';

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function readHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(historyKey) || '[]');
      return Array.isArray(saved) ? saved.slice(0, 10) : [];
    } catch {
      return [];
    }
  }

  function saveHistory(entry) {
    try {
      localStorage.setItem(historyKey, JSON.stringify([entry, ...readHistory()].slice(0, 10)));
    } catch {
      // Local history is optional; generation still succeeds when storage is unavailable.
    }
  }

  function draftText(draft) {
    const notes = Array.isArray(draft.reviewNotes) && draft.reviewNotes.length
      ? `\nReview notes:\n${draft.reviewNotes.map((note) => `- ${note}`).join('\n')}`
      : '';
    return `${draft.platform || 'Draft'}\n${draft.title || ''}\n\n${draft.body || ''}${notes}`.trim();
  }

  async function copyText(text) {
    if (!text) throw new Error('There is no draft text to copy.');
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const temporaryInput = document.createElement('textarea');
    temporaryInput.value = text;
    temporaryInput.setAttribute('readonly', '');
    temporaryInput.className = 'clipboard-fallback';
    document.body.append(temporaryInput);
    temporaryInput.select();
    const copied = document.execCommand('copy');
    temporaryInput.remove();
    if (!copied) throw new Error('Clipboard access is unavailable.');
  }

  function setPlatforms(platforms) {
    const selected = new Set(Array.isArray(platforms) ? platforms : []);
    for (const checkbox of form.querySelectorAll('input[name="platform"]')) {
      checkbox.checked = selected.has(checkbox.value);
    }
  }

  function restoreSession(session) {
    form.productName.value = typeof session.productName === 'string' ? session.productName : '';
    form.productDescription.value = typeof session.productDescription === 'string' ? session.productDescription : '';
    form.tone.value = typeof session.tone === 'string' ? session.tone : 'clear and helpful';
    setPlatforms(session.platforms);
    renderDrafts({ drafts: Array.isArray(session.drafts) ? session.drafts : [] });
    setStatus('Local session restored. Review the facts again before generating or copying.');
  }

  function renderHistory() {
    const entries = readHistory();
    historyList.replaceChildren();
    for (const session of entries) {
      const item = document.createElement('article');
      item.className = 'history-item';
      const details = document.createElement('div');
      const name = document.createElement('strong');
      appendText(name, session.productName || 'Untitled product');
      const metadata = document.createElement('span');
      const time = typeof session.createdAt === 'string' ? new Date(session.createdAt) : null;
      const label = time && !Number.isNaN(time.valueOf()) ? time.toLocaleString() : 'Saved local session';
      appendText(metadata, label);
      details.append(name, metadata);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'quiet-button';
      restore.textContent = 'Restore';
      restore.addEventListener('click', () => restoreSession(session));
      item.append(details, restore);
      historyList.append(item);
    }
    historySection.classList.toggle('hidden', entries.length === 0);
  }

  function appendText(element, text) {
    element.textContent = typeof text === 'string' ? text : '';
  }

  function renderDrafts(data) {
    results.replaceChildren();
    const drafts = data && Array.isArray(data.drafts) ? data.drafts : [];
    for (const draft of drafts) {
      const article = document.createElement('article');
      article.className = 'draft';
      const heading = document.createElement('h3');
      appendText(heading, draft.platform || 'Draft');
      const title = document.createElement('input');
      title.value = draft.title || '';
      title.setAttribute('aria-label', `${draft.platform || 'Draft'} title`);
      const body = document.createElement('textarea');
      body.value = draft.body || '';
      body.setAttribute('aria-label', `${draft.platform || 'Draft'} body`);
      const notes = document.createElement('ul');
      notes.className = 'review-notes';
      for (const note of Array.isArray(draft.reviewNotes) ? draft.reviewNotes : []) {
        const item = document.createElement('li');
        appendText(item, note);
        notes.append(item);
      }
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'quiet-button copy-button';
      copy.textContent = 'Copy draft';
      copy.addEventListener('click', async () => {
        try {
          await copyText(draftText({
            platform: draft.platform,
            title: title.value,
            body: body.value,
            reviewNotes: Array.from(notes.querySelectorAll('li')).map((item) => item.textContent || '')
          }));
          setStatus('Draft copied to your clipboard.');
        } catch {
          setStatus('Could not copy the draft. Select the text manually and copy it.', true);
        }
      });
      article.append(heading, title, body, copy);
      if (notes.childElementCount) article.append(notes);
      results.append(article);
    }
    resultSection.classList.toggle('hidden', drafts.length === 0);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const platforms = [...form.querySelectorAll('input[name="platform"]:checked')].map((item) => item.value);
    if (platforms.length === 0) {
      setStatus('Select at least one platform.', true);
      return;
    }
    const payload = {
      productName: form.productName.value.trim(),
      productDescription: form.productDescription.value.trim(),
      tone: form.tone.value.trim(),
      platforms
    };
    submitButton.disabled = true;
    setStatus('Generating editable drafts…');
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result && result.error && result.error.message ? result.error.message : 'Unable to generate drafts.');
      renderDrafts(result.data);
      saveHistory({ createdAt: new Date().toISOString(), ...payload, drafts: result.data.drafts });
      renderHistory();
      setStatus('Drafts generated. Review every claim before use.');
    } catch (error) {
      setStatus(error && error.message ? error.message : 'Unable to generate drafts.', true);
    } finally {
      submitButton.disabled = false;
    }
  });

  clearHistory.addEventListener('click', () => {
    localStorage.removeItem(historyKey);
    renderHistory();
    setStatus('Local history cleared.');
  });

  copyAll.addEventListener('click', async () => {
    const drafts = Array.from(results.querySelectorAll('.draft')).map((article) => ({
      platform: article.querySelector('h3').textContent || 'Draft',
      title: article.querySelector('input').value,
      body: article.querySelector('textarea').value,
      reviewNotes: Array.from(article.querySelectorAll('.review-notes li')).map((item) => item.textContent || '')
    }));
    try {
      await copyText(drafts.map(draftText).join('\n\n---\n\n'));
      setStatus('All current drafts copied to your clipboard.');
    } catch {
      setStatus('Could not copy the drafts. Select the text manually and copy it.', true);
    }
  });

  renderHistory();
})();
