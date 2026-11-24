import { EventEmitter } from 'node:events';

// 进程内事件总线：runner 发布 -> SSE 路由订阅
export const bus = new EventEmitter();
bus.setMaxListeners(200);

export function publish(sessionId, event) {
  bus.emit(`session:${sessionId}`, event);
}

export function subscribe(sessionId, fn) {
  const key = `session:${sessionId}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}
