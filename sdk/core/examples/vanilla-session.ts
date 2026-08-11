import type { SessionView } from "../src/index.js";
import { SessionClient, type SessionClientOptions } from "./session-client.js";

/** Bind a session to ordinary DOM elements. No UI framework is required. */
export function bindVanillaSession(
  root: HTMLElement,
  sessionId: string,
  options: SessionClientOptions = {},
): () => void {
  const output = requiredElement<HTMLOutputElement>(root, "[data-session-output]");
  const form = requiredElement<HTMLFormElement>(root, "[data-session-form]");
  const input = requiredElement<HTMLInputElement>(root, "[data-session-input]");
  const interrupt = requiredElement<HTMLButtonElement>(root, "[data-session-interrupt]");
  const client = new SessionClient(undefined, options);

  const render = (view: SessionView): void => {
    output.textContent = view.content
      .map((chunk) =>
        chunk.chunkType === "text"
          ? chunk.text
          : chunk.chunkType === "thinking"
            ? `[thinking] ${chunk.thinking}`
            : `[tool] ${chunk.name}`,
      )
      .join("");
  };

  const disconnect = client.connect(sessionId, {
    onView: render,
    onError: (error) => {
      output.textContent = `Session error: ${error.message}`;
    },
  });

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const text = input.value;
    void client.submitText(sessionId, text).then(() => {
      input.value = "";
    });
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

function requiredElement<T extends Element>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`missing required session element: ${selector}`);
  return element;
}
