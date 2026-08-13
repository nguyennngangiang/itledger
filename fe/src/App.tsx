import "./App.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dropdown } from "antd";
import loadingGif from "./assets/loading.gif";
import { useLoading } from "./hook/LoadingContext";
import { SparkleBackground } from "./components/SparkleBackground";
import {
  installSparkleClicks,
  installButtonPress,
  animateEntrance,
  animateSwitch,
  hideNavIndicator,
  slideNavIndicator,
} from "./lib/sparkle";
import { Dashboard } from "./components/Dashboard";
import { DeviceMainScreen } from "./components/DeviceMainScreen";
import { MaintenanceScreen } from "./components/MaintenanceScreen";
import { HandoverScreen } from "./components/HandoverScreen";
import { EmployeeScreen } from "./components/EmployeeScreen";
import { NotificationScreen } from "./components/NotificationScreen";
import { ImportModal } from "./components/Modal/ImportModal";
import type { ImportKind } from "./components/Modal/ImportModal";
import { countOpenIssues } from "./api/imports";
import { useWindowFileDrop } from "./lib/useFileDrop";
import { AssistantModal } from "./components/Modal/AssistantModal";
import { CreateDeviceModal } from "./components/Modal/CreateDeviceModal";
import MaintenanceModal from "./components/Modal/MaintenanceModal";
import HandoverModal from "./components/Modal/HandoverModal";
import EmployeeModal from "./components/Modal/EmployeeModal";
import {
  DeviceIcon,
  WrenchIcon,
  HandoverIcon,
  UserIcon,
  LogoMark,
  PlusIcon,
  BellIcon,
  GlobeIcon,
  SparklesIcon,
  UploadIcon,
  ChevronDownIcon,
} from "./components/icons";
import { useT } from "./i18n/useT";
import type { Key } from "./i18n/catalog";

type Page =
  | "dashboard"
  | "device"
  | "maintenance"
  | "handover"
  | "employee"
  | "notifications";
export type QuickAdd = "device" | "maintenance" | "handover" | "employee";

// Dashboard is reached by the brand button, and Thông báo by the bell — neither is
// a tab, so the nav stays down to the four things you actually work in.
// These carry catalog KEYS, not text — a module-scope constant cannot call the
// translation hook, so the label is resolved at render by whoever reads it.
const NAV: { key: Page; label: Key; icon: React.ReactNode }[] = [
  { key: "device", label: "nav.device", icon: <DeviceIcon size={17} /> },
  { key: "maintenance", label: "nav.maintenance", icon: <WrenchIcon size={17} /> },
  { key: "handover", label: "nav.handover", icon: <HandoverIcon size={17} /> },
  { key: "employee", label: "nav.employee", icon: <UserIcon size={17} /> },
];

const QUICK_ADD: { key: QuickAdd; label: Key }[] = [
  { key: "device", label: "quickAdd.device" },
  { key: "maintenance", label: "quickAdd.maintenance" },
  { key: "handover", label: "quickAdd.handover" },
  { key: "employee", label: "quickAdd.employee" },
];

// What the Import dropdown offers. Clicking the button itself (rather than a menu
// item) opens the same modal with no kind chosen, and it detects the file instead.
const IMPORT_KINDS: { key: ImportKind; label: Key }[] = [
  { key: "device_list", label: "importKind.device_list" },
  { key: "maintenance_list", label: "importKind.maintenance_list" },
  { key: "handover_minutes", label: "importKind.handover_minutes" },
];

function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [createModal, setCreateModal] = useState<QuickAdd | null>(null);
  const [refresh, setRefresh] = useState({
    device: 0,
    maintenance: 0,
    handover: 0,
    employee: 0,
  });
  const { loading } = useLoading();

  // Open import issues, for the nav badge. Refetched whenever a page switch or an
  // import could have changed the count — there is no push channel, and polling a
  // LAN app every few seconds would be noise for a number that changes by hand.
  // null = closed. "auto" lets the importer detect the file's kind.
  const [importKind, setImportKind] = useState<ImportKind | "auto" | null>(null);
  const [importMenu, setImportMenu] = useState(false);
  // Ask AI lives in the header, not on the Devices screen: it answers across
  // devices, repairs and handovers, so tying it to one tab hid it from the other
  // three. The chat itself is stored per browser session, so moving between tabs
  // no longer loses it either.
  const [showAssistant, setShowAssistant] = useState(false);

  // Files dragged onto the window, handed to the importer. `at` is the trigger, not
  // the array: dropping a second batch onto the already-open dialog has to append,
  // and a fresh array with the same contents would otherwise look like no change.
  const [dropped, setDropped] = useState<{ files: File[]; at: number } | null>(null);
  const takeDroppedFiles = useCallback((files: File[]) => {
    setDropped({ files, at: Date.now() });
    // Anything dragged in wants the auto-detecting front door. Choosing a kind from
    // the header dropdown is a deliberate act; dragging a file is not, so guessing
    // "device list" for a handover record would be the wrong default.
    setImportKind((open) => open ?? "auto");
  }, []);
  const draggingFile = useWindowFileDrop(takeDroppedFiles);

  const [openIssues, setOpenIssues] = useState(0);
  const refreshIssueCount = useCallback(() => {
    countOpenIssues()
      .then((r) => setOpenIssues(r.open))
      .catch(() => {}); // a badge is not worth an error toast
  }, []);
  useEffect(refreshIssueCount, [refreshIssueCount, page, refresh.handover]);

  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  // Global click sparkles + springy press feedback on hero controls.
  useEffect(() => installSparkleClicks(), []);
  useEffect(() => installButtonPress(), []);

  // Sparkly staggered entrance for the top bar + nav on first paint. These
  // selectors must track the header markup — a rename here fails silently.
  useEffect(() => {
    animateEntrance(
      ".topbar-brand, .topnav-item, .topbar-btn, .topbar-globe, .topbar-bell",
      55,
    );
  }, []);

  // Re-run the (bigger, smoother) page entrance whenever the page changes.
  useEffect(() => {
    animateSwitch(".app-content > *", 55);
  }, [page]);

  // Slide the nav highlight pill under the active tab on every switch.
  //
  // Dashboard (the brand) and Notifications (the bell) are pages with no tab of
  // their own, so the pill has to RETRACT rather than stay parked under the tab
  // you came from: that tab loses `.active` and with it its white text, leaving
  // dark text sitting on an orphaned purple slab.
  useEffect(() => {
    const ind = indicatorRef.current;
    if (!ind) return;
    const active = navRef.current?.querySelector<HTMLElement>(".topnav-item.active");
    if (active) slideNavIndicator(ind, active);
    else hideNavIndicator(ind);
  }, [page]);

  // Open a create modal as an overlay WITHOUT navigating away from the
  // current page. (Previously this switched pages and, via a mount effect,
  // caused nav clicks to auto-open modals — that bug is gone now.)
  const openCreate = (target: QuickAdd) => setCreateModal(target);

  const closeCreate = () => {
    if (createModal) setRefresh((r) => ({ ...r, [createModal]: r[createModal] + 1 }));
    setCreateModal(null);
  };

  const { t, toggle, scrambled } = useT();
  // `page` is a closed union, so these concatenated keys are always real ones.
  const title = t(`page.${page}.title` as Key);
  const subtitle = t(`page.${page}.subtitle` as Key);

  return (
    <>
      <SparkleBackground />

      {loading && (
        <div className="app-loading-overlay">
          <div className="app-loading-card">
            <img className="app-loading-gif" src={loadingGif} alt={t("common.loading")} />
            <span>{t("common.loading")}</span>
          </div>
        </div>
      )}

      <div className="app-shell">
        <header className="topbar">
          {/* The brand IS the Dashboard link — it used to be a sixth tab. */}
          <button
            className={`topbar-brand${page === "dashboard" ? " active" : ""}`}
            aria-current={page === "dashboard" ? "page" : undefined}
            title={t("header.brandTitle")}
            onClick={() => setPage("dashboard")}
          >
            <span className="topbar-logo">
              <LogoMark size={20} />
            </span>
            <span className="topbar-brand-name">{t("app.name")}</span>
          </button>

          <nav className="topnav" ref={navRef}>
            <span className="topnav-indicator" ref={indicatorRef} />
            {NAV.map((item) => (
              <button
                key={item.key}
                className={`topnav-item${page === item.key ? " active" : ""}`}
                // The .active class is styling only — screen readers need this
                // to know which tab is the one currently showing.
                aria-current={page === item.key ? "page" : undefined}
                onClick={() => setPage(item.key)}
              >
                {item.icon}
                <span>{t(item.label)}</span>
              </button>
            ))}
          </nav>

          <div className="topbar-actions">
            <button
              className="topbar-btn"
              onClick={() => setShowAssistant(true)}
              title={t("header.askAiTitle")}
            >
              <SparklesIcon size={15} />
              <span>{t("header.askAi")}</span>
            </button>

            {/* Four separate add buttons collapsed into one menu. Hover opens it
                for the mouse; click opens it too, because hover alone is not
                reachable by keyboard or on a touch screen. */}
            <Dropdown
              trigger={["hover", "click"]}
              menu={{
                items: QUICK_ADD.map((q) => ({ key: q.key, label: t(q.label) })),
                onClick: ({ key }) => openCreate(key as QuickAdd),
              }}
            >
              <button className="topbar-btn" aria-haspopup="menu">
                <PlusIcon size={15} />
                <span>{t("header.add")}</span>
                <ChevronDownIcon size={14} />
              </button>
            </Dropdown>

            {/* Split control: the label imports a file and lets the server work
                out what it is; the caret picks the kind explicitly. Hover opens
                the menu, and the caret is a real button so keyboard and touch
                can reach it — which a hover-only menu cannot. */}
            <Dropdown
              trigger={["hover"]}
              open={importMenu}
              onOpenChange={setImportMenu}
              menu={{
                items: IMPORT_KINDS.map((k) => ({ key: k.key, label: t(k.label) })),
                onClick: ({ key }) => {
                  setImportMenu(false);
                  setImportKind(key as ImportKind);
                },
              }}
            >
              <span className="topbar-split">
                <button
                  className="topbar-btn topbar-btn--main"
                  onClick={() => setImportKind("auto")}
                  title={t("header.importTitle")}
                >
                  <UploadIcon size={15} />
                  <span>{t("header.import")}</span>
                </button>
                <button
                  className="topbar-btn topbar-btn--caret"
                  aria-haspopup="menu"
                  aria-expanded={importMenu}
                  aria-label={t("header.importKindAria")}
                  onClick={() => setImportMenu((v) => !v)}
                >
                  <ChevronDownIcon size={14} />
                </button>
              </span>
            </Dropdown>

            {/* Shuffles every string into a different language, one per string.
                Press again for English. */}
            <button
              className={`topbar-globe${scrambled ? " on" : ""}`}
              onClick={toggle}
              aria-pressed={scrambled}
              aria-label={t(scrambled ? "header.scramble.off" : "header.scramble.on")}
              title={t(scrambled ? "header.scramble.off" : "header.scramble.on")}
            >
              <GlobeIcon size={18} />
            </button>

            <button
              className={`topbar-bell${page === "notifications" ? " active" : ""}`}
              onClick={() => setPage("notifications")}
              aria-current={page === "notifications" ? "page" : undefined}
              aria-label={
                openIssues
                  ? t("header.bell.some", { n: openIssues })
                  : t("header.bell.none")
              }
              title={t("header.bellTitle")}
            >
              <BellIcon size={18} />
              {openIssues > 0 && (
                <span className="topbar-bell-badge">{openIssues}</span>
              )}
            </button>
          </div>
        </header>

        <div className="page-subheader">
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>

        <main
          className={
            "app-content" + (page === "dashboard" ? "" : " app-content--flex")
          }
        >
          {page === "dashboard" && <Dashboard refreshKey={refresh.device} />}
          {page === "device" && (
            <DeviceMainScreen
              refreshKey={refresh.device}
              onAdd={() => openCreate("device")}
            />
          )}
          {page === "maintenance" && (
            <MaintenanceScreen
              refreshKey={refresh.maintenance}
              onAdd={() => openCreate("maintenance")}
            />
          )}
          {page === "handover" && (
            <HandoverScreen
              refreshKey={refresh.handover}
              onAdd={() => openCreate("handover")}
            />
          )}
          {page === "employee" && (
            <EmployeeScreen
              refreshKey={refresh.employee}
              onAdd={() => openCreate("employee")}
            />
          )}
          {page === "notifications" && (
            <NotificationScreen
              refreshKey={refresh.handover}
              onChanged={refreshIssueCount}
            />
          )}
        </main>
      </div>

      {/* Global create modals — open over any page, never navigate. */}
      {createModal === "device" && <CreateDeviceModal onClose={closeCreate} />}
      {createModal === "maintenance" && <MaintenanceModal onClose={closeCreate} />}
      {createModal === "handover" && <HandoverModal onClose={closeCreate} />}
      {createModal === "employee" && <EmployeeModal onClose={closeCreate} />}

      <AssistantModal
        open={showAssistant}
        onClose={() => setShowAssistant(false)}
      />

      {/* The drag target. Only shown when the dialog is CLOSED — once it is open it
          has its own drop zone, and two overlapping "drop here" surfaces is one
          more than anybody needs. */}
      {draggingFile && !importKind && (
        <div className="dropveil" aria-hidden>
          <div className="dropveil-card">
            <span className="dropveil-glyph">
              <UploadIcon size={30} />
            </span>
            <b>{t("drop.title")}</b>
            <span className="dropveil-hint">{t("drop.hint")}</span>
          </div>
        </div>
      )}

      {importKind && (
        <ImportModal
          kind={importKind}
          incoming={dropped}
          onClose={() => {
            setImportKind(null);
            setDropped(null);
          }}
          onDone={() => {
            // An import can touch every resource and can log issues, so refresh
            // the lot rather than guessing which screen changed.
            setRefresh((r) => ({
              device: r.device + 1,
              maintenance: r.maintenance + 1,
              handover: r.handover + 1,
              employee: r.employee + 1,
            }));
            refreshIssueCount();
          }}
        />
      )}
    </>
  );
}

export default App;
