import "./style.css";
import { setStrumVisible } from "./strum/strum";
import { setLegatoVisible } from "./legato/legato";
import { setWaveVisible } from "./wave/wave";
import { initMenubars } from "./menu";

const TABS = ["strum", "legato", "wave"] as const;
type Tab = (typeof TABS)[number];

function show() {
  const hash = location.hash.slice(1);
  const tab: Tab = (TABS as readonly string[]).includes(hash) ? (hash as Tab) : "strum";
  for (const t of TABS) {
    document.getElementById(`tab-${t}`)!.hidden = t !== tab;
    document.querySelector(`.tabs a[href="#${t}"]`)!.setAttribute("aria-current", t === tab ? "page" : "false");
  }
  setStrumVisible(tab === "strum");
  setLegatoVisible(tab === "legato");
  setWaveVisible(tab === "wave");
}

initMenubars();
window.addEventListener("hashchange", show);
show();
