/**
 * SCP adapter — functionally identical to SFTP.
 *
 * Modern SCP implementations use the SFTP subsystem over SSH2.
 * The ssh2 library provides the same SFTP interface regardless of
 * whether the user specifies scp:// or sftp://.
 */
import { SftpAdapter } from './sftp.js';

export class ScpAdapter extends SftpAdapter {}
