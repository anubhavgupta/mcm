import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { NativeInferencePage } from './components/NativeInferencePage';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('The app root element is missing.');
createRoot(root).render(<StrictMode>{window.location.pathname === '/inference' ? <NativeInferencePage /> : <App />}</StrictMode>);
