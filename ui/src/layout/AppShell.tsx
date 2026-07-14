import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

const STORAGE_KEY = 'kliva-sidebar-collapsed';

type NavIconName = 'dashboard' | 'bots' | 'contas' | 'cpfs' | 'whatsapp' | 'grupos' | 'settings';

const links: {
  to: string;
  label: string;
  end?: boolean;
  icon: NavIconName;
}[] = [
  { to: '/', label: 'Dashboard', end: true, icon: 'dashboard' },
  { to: '/bots', label: 'Bots', icon: 'bots' },
  { to: '/contas', label: 'Contas', icon: 'contas' },
  { to: '/cpfs', label: 'CPFs', icon: 'cpfs' },
  { to: '/whatsapp', label: 'WhatsApp', icon: 'whatsapp' },
  { to: '/grupos', label: 'Grupos WA', icon: 'grupos' },
  { to: '/configuracoes', label: 'Configurações', icon: 'settings' },
];

function NavIcon({ name }: { name: NavIconName }) {
  const props = {
    width: 20,
    height: 20,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'dashboard':
      return (
        <svg {...props}>
          <rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.5" />
          <rect x="11" y="2.5" width="6.5" height="6.5" rx="1.5" />
          <rect x="2.5" y="11" width="6.5" height="6.5" rx="1.5" />
          <rect x="11" y="11" width="6.5" height="6.5" rx="1.5" />
        </svg>
      );
    case 'bots':
      return (
        <svg {...props}>
          <rect x="4" y="5.5" width="12" height="9" rx="2" />
          <path d="M8 3.5v2M12 3.5v2" />
          <circle cx="8" cy="10" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="12" cy="10" r="0.75" fill="currentColor" stroke="none" />
          <path d="M7.5 13h5" />
        </svg>
      );
    case 'contas':
      return (
        <svg {...props}>
          <circle cx="8" cy="7" r="3" />
          <path d="M3.5 16.5c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" />
          <path d="M14.5 6.5a2.5 2.5 0 0 1 0 5M16.5 16.5c0-2-1.2-3.7-3-4.3" />
        </svg>
      );
    case 'cpfs':
      return (
        <svg {...props}>
          <rect x="4" y="3" width="12" height="14" rx="2" />
          <path d="M7.5 7.5h5M7.5 10.5h5M7.5 13.5h3" />
        </svg>
      );
    case 'grupos':
      return (
        <svg {...props}>
          <circle cx="7" cy="8" r="2.5" />
          <circle cx="13" cy="8" r="2.5" />
          <path d="M3.5 15c0-2 1.5-3.5 3.5-3.5s3.5 1.5 3.5 3.5M10 15c0-2 1.5-3.5 3.5-3.5s3.5 1.5 3.5 3.5" />
        </svg>
      );
    case 'whatsapp':
      return (
        <svg {...props}>
          <path d="M10 17.5c3.5 0 6.5-2.8 6.5-6.2S13.5 5 10 5 3.5 7.8 3.5 11.3c0 1.1.3 2.1.9 3L3 16l1.8-.5c.9.6 2 1 3.2 1" />
          <path d="M7.8 9.8l1.2 2.5 2.8.4-2 1.9.5 2.8-2.5-1.3-2.5 1.3.5-2.8-2-1.9 2.8-.4 1.2-2.5z" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...props}>
          <path d="M10 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z" />
          <path d="M16.1 11.4c.05-.47.08-.95.08-1.4s-.03-.93-.08-1.4l1.45-1.13a.75.75 0 0 0 .18-.97l-1.38-2.39a.75.75 0 0 0-.9-.33l-1.71.69a7.2 7.2 0 0 0-1.21-.7l-.26-1.82A.75.75 0 0 0 11.2 2.5H8.8a.75.75 0 0 0-.74.63l-.26 1.82c-.43.17-.84.4-1.21.7l-1.71-.69a.75.75 0 0 0-.9.33L2.6 6.9a.75.75 0 0 0 .18.97l1.45 1.13c-.05.47-.08.95-.08 1.4s.03.93.08 1.4l-1.45 1.13a.75.75 0 0 0-.18.97l1.38 2.39c.2.35.6.48.9.33l1.71-.69c.37.3.78.53 1.21.7l.26 1.82c.08.35.39.63.74.63h2.4c.35 0 .66-.28.74-.63l.26-1.82c.43-.17.84-.4 1.21-.7l1.71.69c.31.12.7 0 .9-.33l1.38-2.39a.75.75 0 0 0-.18-.97l-1.45-1.13Z" />
        </svg>
      );
  }
}

function readCollapsed() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleSidebar = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <div className={`app-shell${collapsed ? ' app-shell--sidebar-collapsed' : ''}`}>
      <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
        <div className="sidebar-logo">
          <img src="/logo.png" alt="KLIVA" className="sidebar-logo-icon" />
          <div className="sidebar-logo-text">
            <h1>KLIVA</h1>
            <span>Operação</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              title={collapsed ? link.label : undefined}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <span className="nav-link-icon">
                <NavIcon name={link.icon} />
              </span>
              <span className="nav-link-label">{link.label}</span>
            </NavLink>
          ))}
        </nav>

        <button
          type="button"
          className="sidebar-toggle"
          onClick={toggleSidebar}
          title={collapsed ? 'Expandir menu' : 'Recolher menu'}
          aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
          aria-expanded={!collapsed}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            {collapsed ? (
              <path d="M6.5 4.5 11 9l-4.5 4.5" />
            ) : (
              <path d="M11.5 4.5 7 9l4.5 4.5" />
            )}
          </svg>
          <span className="sidebar-toggle-label">
            {collapsed ? 'Expandir' : 'Recolher'}
          </span>
        </button>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
