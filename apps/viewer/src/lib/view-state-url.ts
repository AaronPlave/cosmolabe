import { decodeViewState, encodeViewState, ViewStateError, type ViewStateV1 } from '@cosmolabe/control';
import { validateEventLinkState, type EventLinkState } from './event-link-state';
import { withCatalogLocation } from './catalog-nav';

export type ViewerViewState = ViewStateV1 & { events?: EventLinkState };

/** No scripts are accepted. The validated state is the entire URL API. */
export function requestedView(search: string): ViewerViewState | null {
  const text = new URLSearchParams(search).get('view');
  if (text === null) return null;
  const base = decodeViewState(text);
  const raw = JSON.parse(text) as Record<string, unknown>;
  return { ...base, ...(raw.events === undefined ? {} : { events: validateEventLinkState(raw.events) }) };
}

export function viewLink(state: ViewerViewState, pageUrl: string): string {
  const url = new URL(pageUrl);
  url.search = withCatalogLocation(url.search, state.catalog);
  const base = JSON.parse(encodeViewState(state)) as ViewStateV1;
  const payload = JSON.stringify({ ...base, ...(state.events ? { events: validateEventLinkState(state.events) } : {}) });
  if (payload.length > 8192) throw new ViewStateError('View link is too large; share fewer event searches.');
  url.searchParams.set('view', payload);
  // Test mode is local harness behavior, not part of a shareable view.
  url.searchParams.delete('test');
  if (url.href.length > 8192) throw new ViewStateError('View link is too large for an ordinary URL.');
  return url.href;
}
