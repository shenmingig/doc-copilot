// ============================================================
// Popup Script
// ============================================================

import { settingsStorage } from '../shared/storage/settings';
import { isAiConfigured } from '../shared/types/index';

const ALL_SITES_ORIGINS = ['https://*/*'];

async function init() {
  const settings = await settingsStorage.get();
  const configured = isAiConfigured(settings);

  const dot = document.getElementById('statusDot')!;
  const text = document.getElementById('statusText')!;

  if (configured) {
    dot.classList.add('active');
    text.textContent = 'Configured — AI service ready';
  } else {
    text.textContent = 'Not configured — open Settings to set URL, SK, and model';
  }

  const allSitesToggle = document.getElementById('allSitesToggle') as HTMLInputElement;
  const allSitesStatus = document.getElementById('allSitesStatus')!;
  const allSitesEnabled = await chrome.permissions.contains({ origins: ALL_SITES_ORIGINS });
  allSitesToggle.checked = allSitesEnabled;
  allSitesStatus.textContent = allSitesEnabled
    ? '已授权：所有 HTTPS 网站'
    : '未授权：仅支持内置常用站点';

  allSitesToggle.addEventListener('change', async () => {
    allSitesToggle.disabled = true;
    try {
      if (allSitesToggle.checked) {
        const granted = await chrome.permissions.request({ origins: ALL_SITES_ORIGINS });
        if (!granted) {
          allSitesToggle.checked = false;
          allSitesStatus.textContent = '未获得全站权限';
          return;
        }
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await chrome.runtime.sendMessage({
          type: 'ENABLE_ALL_SITES',
          payload: { activeTabId: activeTab?.id },
        });
        allSitesStatus.textContent = '已授权：所有 HTTPS 网站';
      } else {
        await chrome.runtime.sendMessage({ type: 'DISABLE_ALL_SITES' });
        await chrome.permissions.remove({ origins: ALL_SITES_ORIGINS });
        allSitesStatus.textContent = '已关闭；当前页面刷新后生效';
      }
    } catch (error) {
      allSitesToggle.checked = await chrome.permissions.contains({ origins: ALL_SITES_ORIGINS });
      allSitesStatus.textContent = `切换失败：${(error as Error).message}`;
    } finally {
      allSitesToggle.disabled = false;
    }
  });

  // Send commands to active tab
  function sendToTab(msg: { type: string; payload?: unknown }) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, msg);
        window.close();
      }
    });
  }

  document.getElementById('btnTogglePanel')!.addEventListener('click', () => {
    sendToTab({ type: 'COMMAND', payload: { command: 'toggle-panel' } });
  });

  document.getElementById('btnReview')!.addEventListener('click', () => {
    sendToTab({ type: 'CONTEXT_MENU_ACTION', payload: { action: 'command:review' } });
  });

  document.getElementById('btnSettings')!.addEventListener('click', () => {
    sendToTab({ type: 'COMMAND', payload: { command: 'open-settings' } });
  });
}

init();
