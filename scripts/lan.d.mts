// SPDX-License-Identifier: AGPL-3.0-only
import type { NetworkInterfaceInfo } from "node:os";
export function lanAddress(ifaces?: NodeJS.Dict<NetworkInterfaceInfo[]>, env?: NodeJS.ProcessEnv): string | null;
export function devOrigins(port: number | string, ifaces?: NodeJS.Dict<NetworkInterfaceInfo[]>, env?: NodeJS.ProcessEnv): string;
