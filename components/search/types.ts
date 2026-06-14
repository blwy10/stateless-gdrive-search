// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

export type User = {
  name: string | null;
  email: string | null;
  image: string | null;
};

export type DriveConnection = {
  id: string;
  driveEmail: string;
  driveName: string | null;
  expiresAt: string | null;
  scope: string;
  createdAt: string;
  updatedAt: string;
};
