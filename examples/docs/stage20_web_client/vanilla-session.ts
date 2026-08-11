import type { SessionView } from "@looprig/client";
import { SessionClient, type SessionClientOptions } from "./session-client.js";

/** A complete browser binding using only the DOM and the framework-neutral client. */
export function bindVanillaSession(
  root: HTMLElement,
  sessionId: string,
  options: SessionClientOptions = {},
): () => void {
  const output = required<HTMLOutputElement>(root, "[data-session-output]");
  const form = required<HTMLFormElement>(root, "[data-session-form]");
  const input = required<HTMLInputElement>(root, "[data-session-input]");
  const interrupt = required<HTMLButtonElement>(root, "[data-session-interrupt]");
  const client = new SessionClient(undefined, options);

  const render = (view: SessionView): void => {
    output.textContent = view.content
      .map((chunk) => chunk.chunkType === "text" ? chunk.text : chunk.chunkType === "thinking" ? chunk.thinking : `[tool] ${chunk.name}`)
      .join("");
  };
  const disconnect = client.connect(sessionId, {
    onView: render,
    onError: (error) => { output.textContent = `Session error: ${error.message}`; },
  });
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    void client.submitText(sessionId, input.value).then(() => { input.value = ""; });
  };
  const onInterrupt = (): void => void client.interrupt(sessionId);
  form.addEventListener("submit", onSubmit);
  interrupt.addEventListener("click", onInterrupt);

  return () => {
    disconnect();
    form.removeEventListener("submit", onSubmit);
    interrupt.removeEventListener("click", onInterrupt);
  };
}

function required<T extends Element>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`missing required session element: ${selector}`);
  return element;
}
