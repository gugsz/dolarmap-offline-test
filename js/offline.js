// Prepara os arquivos para abrir pelo ícone da Tela de Início sem conexão.
export async function prepareOffline() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    throw new Error('Para preparar o uso offline, abra o endereço HTTPS do aplicativo.');
  }
  const scope = new URL('../', import.meta.url).href;
  let registration = await navigator.serviceWorker.getRegistration(scope);
  if (navigator.onLine === false && registration?.active) return;
  registration = await navigator.serviceWorker.register(new URL('sw.js', scope), { scope, updateViaCache: 'none' });
  const worker = registration.installing || registration.waiting || registration.active;
  if (!worker) throw new Error('Não foi possível preparar o aplicativo para uso offline.');
  if (worker.state !== 'activated') {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('A preparação offline não terminou. Tente novamente com internet.')), 25000);
      const finish = (error) => {
        clearTimeout(timer);
        worker.removeEventListener('statechange', check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (worker.state === 'activated') finish();
        if (worker.state === 'redundant') finish(new Error('Não foi possível baixar todos os arquivos para uso offline.'));
      };
      worker.addEventListener('statechange', check);
      check();
    });
  }
  // Pedido sem garantia: o iPhone decide se concede armazenamento persistente.
  navigator.storage?.persist?.().catch(() => {});
}
