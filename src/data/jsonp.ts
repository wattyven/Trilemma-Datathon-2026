// JSONP fallback, isolated in a sandboxed iframe. The iframe has an opaque origin
// (`allow-scripts` without `allow-same-origin`), so the remote script can't touch this page;
// only the structured-cloned payload crosses back via postMessage. Verified in Phase 0.
import { REQUEST_TIMEOUT_MS } from '../config';
import { abortError, TimeoutError } from './http';

const CALLBACK = 'vanshadeJsonp';

/** `buildUrl` receives the callback name the response must call. */
export function jsonpViaSandbox<T>(
  buildUrl: (callbackName: string) => string,
  { signal, timeoutMs = REQUEST_TIMEOUT_MS }: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  const url = buildUrl(CALLBACK);
  return new Promise<T>((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.sandbox.add('allow-scripts');
    iframe.hidden = true;
    iframe.title = 'Data loader';

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      iframe.remove();
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      cleanup();
      const data = ev.data as { payload?: T; error?: string } | null;
      if (data && 'payload' in data) resolve(data.payload as T);
      else reject(new Error(data?.error ?? 'JSONP failed'));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new TimeoutError(url));
    }, timeoutMs);

    window.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, { once: true });

    const src = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    iframe.srcdoc =
      `<script>window.${CALLBACK}=function(d){parent.postMessage({payload:d},'*')}<\/script>` +
      `<script src="${src}" onerror="parent.postMessage({error:'load error'},'*')"><\/script>`;
    document.body.appendChild(iframe);
  });
}
