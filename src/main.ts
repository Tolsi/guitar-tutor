import "./style.css";
import { setStrumVisible } from "./strum/strum";
import { setLegatoVisible } from "./legato/legato";

const TABS = ["strum", "legato"] as const;
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
}

window.addEventListener("hashchange", show);
show();
