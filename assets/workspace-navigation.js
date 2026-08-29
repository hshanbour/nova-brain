export function selectWorkspace({ workspaces, links, name }) {
  const available = [...workspaces];
  const selected = available.some((workspace) => workspace.id === name) ? name : "chat";

  for (const workspace of available) workspace.hidden = workspace.id !== selected;
  for (const link of links) {
    const active = link.dataset.section === selected;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  return selected;
}
