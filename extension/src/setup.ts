import { loadSettings, saveSettings, type Settings } from "./shared.js";

const form = document.getElementById("form") as HTMLFormElement;
const status = document.getElementById("status")!;
const rubricSelect = form.elements.namedItem("rubricId") as HTMLSelectElement;

async function loadRubrics(s: Settings): Promise<void> {
  try {
    const res = await fetch(new URL("/api/rubrics", s.serverUrl), { headers: s.token ? { Authorization: `Bearer ${s.token}` } : {} });
    if (!res.ok) throw new Error(res.status === 401 ? "the access token was rejected" : `server replied ${res.status}`);
    const rubrics = (await res.json()) as Array<{ id: string; name: string }>;
    rubricSelect.replaceChildren(...rubrics.map((r) => new Option(r.name, r.id)));
    rubricSelect.value = rubrics.some((r) => r.id === s.rubricId) ? s.rubricId : (rubrics[0]?.id ?? "");
    status.textContent = "Connected to the server.";
  } catch (err) {
    rubricSelect.replaceChildren(new Option(s.rubricId, s.rubricId));
    status.textContent = `Couldn't reach the server: ${(err as Error).message}`;
  }
}

void loadSettings().then((s) => {
  for (const key of ["serverUrl", "token", "agentName"] as const) (form.elements.namedItem(key) as HTMLInputElement).value = s[key];
  void loadRubrics(s);
});

form.onsubmit = async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const s: Settings = {
    serverUrl: String(data.get("serverUrl")).replace(/\/+$/, ""),
    token: String(data.get("token") ?? ""),
    rubricId: String(data.get("rubricId") ?? "medicare-tpmo"),
    agentName: String(data.get("agentName") ?? ""),
  };
  await saveSettings(s);
  status.textContent = "Saved.";
  void loadRubrics(s);
};

document.getElementById("mic")!.onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = "Microphone allowed. You're ready to score calls.";
  } catch {
    status.textContent = "Microphone blocked. Click the icon in the address bar to allow it, then try again.";
  }
};
