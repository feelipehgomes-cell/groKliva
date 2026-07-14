import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { BotsPage } from './pages/BotsPage';
import { ContasPage } from './pages/ContasPage';
import { CpfsPage } from './pages/CpfsPage';
import { SettingsPage } from './pages/SettingsPage';
import { GruposPage } from './pages/GruposPage';
import { WhatsAppPage } from './pages/WhatsAppPage';
import './theme/kliva.css';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="bots" element={<BotsPage />} />
          <Route path="contas" element={<ContasPage />} />
          <Route path="cpfs" element={<CpfsPage />} />
          <Route path="grupos" element={<GruposPage />} />
          <Route path="whatsapp" element={<WhatsAppPage />} />
          <Route path="configuracoes" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
