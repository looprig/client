<script lang="ts">
  import { untrack } from "svelte";
  import {
    GATE_APPROVAL_ACTIONS,
    createBFFClient,
    createFetchLiveFrameSource,
    type LooprigTransport,
  } from "@looprig/client";
  import { GateStore, LiveSessionViewStore, SessionComposerStore } from "@looprig/svelte";

  let { sessionId, transport = createBFFClient() }: { sessionId: string; transport?: LooprigTransport } = $props();
  const live = $derived(new LiveSessionViewStore(transport, sessionId, createFetchLiveFrameSource(sessionId)));
  const composer = $derived(new SessionComposerStore(transport, sessionId));
  const gate = $derived(new GateStore(transport, sessionId));
  let draft = $state("");

  $effect(() => {
    if (sessionId === "") return;
    untrack(() => { live.start(); gate.start(); });
    return () => untrack(() => { live.stop(); gate.stop(); });
  });

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (await composer.submit(draft)) draft = "";
  }
</script>

<h1>Session {sessionId}</h1>
{#if live.error}<p role="alert">{live.error.message}</p>{/if}
{#each live.view.content as chunk}
  <p>{chunk.chunkType === "text" ? chunk.text : chunk.chunkType === "thinking" ? chunk.thinking : `Tool: ${chunk.name}`}</p>
{/each}
{#if gate.waitingGateId}
  <button onclick={() => gate.respond(GATE_APPROVAL_ACTIONS.approve)}>Approve</button>
  <button onclick={() => gate.respond(GATE_APPROVAL_ACTIONS.deny)}>Deny</button>
{/if}
<form onsubmit={send}>
  <label>Message <input bind:value={draft} disabled={composer.submitting} /></label>
  <button type="submit" disabled={composer.submitting || draft.trim() === ""}>Send</button>
</form>
<button type="button" onclick={() => transport.interrupt(sessionId)}>Interrupt</button>
