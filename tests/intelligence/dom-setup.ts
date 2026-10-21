import React from 'react';
import { JSDOM } from 'jsdom';

export const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});

Object.defineProperty(dom.window, 'requestIdleCallback', {
  configurable: true,
  value: (callback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void) =>
    setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 1),
});
Object.defineProperty(dom.window, 'cancelIdleCallback', {
  configurable: true,
  value: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
});

Object.defineProperties(globalThis, {
  self: { configurable: true, value: dom.window },
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  Event: { configurable: true, value: dom.window.Event },
  NodeFilter: { configurable: true, value: dom.window.NodeFilter },
  CustomEvent: { configurable: true, value: dom.window.CustomEvent },
  MouseEvent: { configurable: true, value: dom.window.MouseEvent },
  KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
  MutationObserver: { configurable: true, value: dom.window.MutationObserver },
  getComputedStyle: {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  },
  IS_REACT_ACT_ENVIRONMENT: {
    configurable: true,
    writable: true,
    value: true,
  },
  React: { configurable: true, value: React },
});
