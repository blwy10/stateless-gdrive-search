// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth";
import { listDriveConnections } from "@/lib/drive-connections";
import { getModelSettingsSummary } from "@/lib/model-settings";
import { SearchApp } from "@/components/search-app";

export default async function Home() {
  const session = await getServerSession(getAuthOptions());
  const connections = session?.user?.id ? await listDriveConnections(session.user.id) : [];
  const modelSettings = session?.user?.id ? await getModelSettingsSummary(session.user.id) : null;

  return (
    <SearchApp
      user={
        session?.user
          ? {
              name: session.user.name ?? null,
              email: session.user.email ?? null,
              image: session.user.image ?? null
            }
          : null
      }
      initialConnections={connections}
      initialModelSettings={modelSettings}
    />
  );
}
