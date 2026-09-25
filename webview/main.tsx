/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import './canvas.css';

import {createRoot} from 'react-dom/client';

import {Canvas, type CanvasHost} from './Canvas';

declare function acquireVsCodeApi(): CanvasHost;

const mount = document.getElementById('root');
if (mount !== null) {
  createRoot(mount).render(<Canvas host={acquireVsCodeApi()} />);
}
