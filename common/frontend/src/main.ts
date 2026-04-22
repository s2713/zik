const mount = document.getElementById("app");

async function render(): Promise<void> {
  if (!mount) return;
  try {
    const response = await fetch("/api/health");
    const body = await response.json();
    mount.textContent = `backend says: ${JSON.stringify(body)}`;
  } catch (err) {
    mount.textContent = `backend unreachable: ${(err as Error).message}`;
  }
}

void render();
