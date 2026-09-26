import { useEffect, useMemo } from 'react';
import { LinkRecoveryController } from '@looprig/client';
import { useFactoryClient, useFactoryLink, useFactoryLinkStatus } from './use-connection.js';

/** Reopens a failed link after an authenticated REST probe. */
export function useLinkRecovery(): void {
  const client = useFactoryClient();
  const link = useFactoryLink();
  const status = useFactoryLinkStatus();
  const recovery = useMemo(() => new LinkRecoveryController({
    probe: (signal) => client.reads.readBootstrap({ signal }),
    open: () => link.open(),
  }), [client, link]);
  useEffect(() => {
    recovery.update(status.state);
    return () => recovery.cancel();
  }, [recovery, status.state]);
}
