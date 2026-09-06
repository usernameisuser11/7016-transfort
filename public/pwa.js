const installButton = document.getElementById('installAppButton');
const networkBadge = document.getElementById('networkBadge');
let deferredInstallPrompt = null;

// AI 분석 요청이 네트워크 문제로 무한정 대기하지 않도록 8초 제한을 둔다.
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input?.url || '');
  if (!url.includes('/api/ai-advice') || init.signal) return nativeFetch(input, init);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  return nativeFetch(input, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer));
};

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function setInstallButtonVisible(visible, label = '앱 설치') {
  if (!installButton) return;
  installButton.hidden = !visible;
  installButton.textContent = label;
}

function updateNetworkBadge() {
  if (!networkBadge) return;
  networkBadge.hidden = navigator.onLine;
  networkBadge.textContent = 'OFFLINE';
}

function showInstallGuide(message) {
  let guide = document.getElementById('pwaInstallGuide');
  if (!guide) {
    guide = document.createElement('div');
    guide.id = 'pwaInstallGuide';
    guide.className = 'pwa-install-guide';
    guide.innerHTML = `
      <div class="pwa-install-card" role="dialog" aria-modal="true" aria-labelledby="pwaInstallTitle">
        <div>
          <span class="section-label">홈 화면에 추가</span>
          <strong id="pwaInstallTitle">상명대 통학을 앱처럼 사용하기</strong>
          <p id="pwaInstallMessage"></p>
        </div>
        <button id="pwaInstallClose" type="button">확인</button>
      </div>`;
    document.body.appendChild(guide);
    guide.querySelector('#pwaInstallClose').addEventListener('click', () => guide.remove());
    guide.addEventListener('click', (event) => {
      if (event.target === guide) guide.remove();
    });
  }
  guide.querySelector('#pwaInstallMessage').textContent = message;
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (!isStandalone()) setInstallButtonVisible(true, '앱 설치');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  setInstallButtonVisible(false);
});

installButton?.addEventListener('click', async () => {
  if (isStandalone()) {
    setInstallButtonVisible(false);
    return;
  }

  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    setInstallButtonVisible(false);
    return;
  }

  if (isIOS()) {
    showInstallGuide('Safari 하단의 공유 버튼을 누른 뒤 “홈 화면에 추가”를 선택하면 됩니다.');
  } else {
    showInstallGuide('Chrome 또는 삼성 인터넷 메뉴에서 “앱 설치” 또는 “홈 화면에 추가”를 선택하면 됩니다.');
  }
});

window.addEventListener('online', updateNetworkBadge);
window.addEventListener('offline', updateNetworkBadge);
updateNetworkBadge();

if (isStandalone()) {
  setInstallButtonVisible(false);
} else {
  setInstallButtonVisible(true, isIOS() ? '홈 화면 추가' : '앱 설치');
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/',
        updateViaCache: 'none'
      });
      registration.update().catch(() => {});
    } catch (error) {
      console.error('PWA service worker registration failed:', error);
    }
  });
}
