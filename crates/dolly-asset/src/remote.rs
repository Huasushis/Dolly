//! Remote acquisition policy and the bounded fetch capability.
//!
//! `remote_url` sources are fetched by a Host-provided transport through the
//! [`RemoteFetcher`] capability. The service enforces the scheme and
//! credential rules, revalidates every resolved IP against the SSRF deny
//! policy before any byte is accepted, revalidates every redirect as a new
//! network target, and caps redirects and response bytes.
//!
//! The default [`DeniedFetcher`] fails closed: without an explicitly wired
//! Host transport, no network byte ever enters the service. This keeps the
//! deny-policy logic real and testable while the HTTPS transport itself
//! remains a Host wiring concern outside this lane.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

/// What a fetch attempt returned before any byte transfer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteOpenError {
    UnsupportedScheme,
    EmbeddedCredentials,
    DnsFailure,
    ConnectDenied,
    Timeout,
    Transport(String),
}

/// One step of reading from an open remote handle. A redirect is a new
/// network target that the service MUST revalidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteRead {
    Data(usize),
    Redirect(String),
    Closed,
    Transport(String),
}

/// Host-provided bounded HTTPS transport. The implementor resolves the host,
/// opens the connection, enforces its own duration/idle bounds, and reports
/// every resolved address so the service can enforce the deny policy.
pub trait RemoteFetcher {
    fn open(&mut self, url: &str) -> Result<Box<dyn RemoteHandle>, RemoteOpenError>;
}

/// An open remote byte stream plus its resolved addresses.
pub trait RemoteHandle {
    /// Every IP the hostname resolved to for this exact fetch attempt
    /// (checks DNS rebinding: the service validates the addresses the
    /// transport actually uses, not a stale lookup).
    fn resolved_addresses(&self) -> Vec<IpAddr>;

    /// Read into `buf`. Callers must re-validate any `Redirect` target.
    fn read(&mut self, buf: &mut [u8]) -> RemoteRead;
}

/// The v1 fail-closed default: no transport is wired in this lane, so every
/// open is refused.
pub struct DeniedFetcher;

impl RemoteFetcher for DeniedFetcher {
    fn open(&mut self, _url: &str) -> Result<Box<dyn RemoteHandle>, RemoteOpenError> {
        Err(RemoteOpenError::Transport(
            "no remote fetch transport is configured".to_string(),
        ))
    }
}

/// The SSRF deny policy: private, loopback, link-local, multicast,
/// metadata-service, and configured internal ranges are denied unless an
/// explicit capability (out of this lane's scope) allows the exact
/// destination.
#[derive(Debug, Clone, Default)]
pub struct SshDenyPolicy {
    /// Additional operator-configured internal ranges (CIDR strings).
    internal_ranges: Vec<IpNet>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IpNet {
    V4(Ipv4Addr, u8),
    V6(Ipv6Addr, u8),
}

impl IpNet {
    fn parse(value: &str) -> Option<IpNet> {
        let (addr, prefix) = match value.split_once('/') {
            Some((a, p)) => (a, p.parse::<u8>().ok()?),
            None => (value, 0),
        };
        if let Ok(ip) = Ipv4Addr::from_str(addr) {
            if prefix <= 32 {
                return Some(IpNet::V4(ip, prefix));
            }
        }
        if let Ok(ip) = Ipv6Addr::from_str(addr) {
            if prefix <= 128 {
                return Some(IpNet::V6(ip, prefix));
            }
        }
        None
    }

    fn contains(&self, ip: IpAddr) -> bool {
        match (*self, ip) {
            (IpNet::V4(net, prefix), IpAddr::V4(ip)) => {
                let mask = if prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - prefix)
                };
                let net = u32::from(net) & mask;
                (u32::from(ip) & mask) == net
            }
            (IpNet::V6(net, prefix), IpAddr::V6(ip)) => {
                if prefix == 0 {
                    return true;
                }
                let shift = 128 - prefix;
                let mask = u128::MAX << shift;
                let net = u128::from(net);
                let ip = u128::from(ip);
                (ip & mask) == (net & mask)
            }
            _ => false,
        }
    }
}

impl SshDenyPolicy {
    pub fn new(internal_ranges: &[String]) -> Self {
        Self {
            internal_ranges: internal_ranges
                .iter()
                .filter_map(|s| IpNet::parse(s))
                .collect(),
        }
    }

    /// Whether an address is hard-denied (private, loopback, link-local,
    /// multicast, unspecified, or in a configured internal range).
    pub fn is_denied(&self, ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(v4) => {
                let octets = v4.octets();
                // 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 224/4,
                // 0/8, 100.64/10 (CGNAT).
                (octets[0] == 10)
                    || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                    || (octets[0] == 192 && octets[1] == 168)
                    || (octets[0] == 127)
                    || (octets[0] == 169 && octets[1] == 254)
                    || (octets[0] >= 224)
                    || (octets[0] == 0)
                    || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                    || self.internal_ranges.iter().any(|n| n.contains(ip))
            }
            IpAddr::V6(v6) => {
                let segs = v6.segments();
                (segs[0] == 0 && segs[1] == 0 && segs[2] == 0 && segs[3] == 0 && segs[4] == 0
                    && segs[5] == 0 && segs[6] == 0 && segs[7] == 1) // ::1
                    || (v6.is_unicast_link_local())
                    || (v6.is_multicast())
                    || (v6.is_unspecified())
                    || (segs[0] & 0xfe00 == 0xfc00) // fc00::/7
                    || (v6.to_ipv4_mapped().is_some_and(|v4| self.is_denied(IpAddr::V4(v4))))
                    || self.internal_ranges.iter().any(|n| n.contains(ip))
            }
        }
    }

    /// Validate a URL for `remote_url`: must be HTTPS, carry no embedded
    /// credentials, and have a non-empty host.
    pub fn validate_url(url: &str) -> Result<(), RemoteOpenError> {
        if !url.starts_with("https://") {
            return Err(RemoteOpenError::UnsupportedScheme);
        }
        let rest = &url[8..];
        // Reject any userinfo before the first '/'.
        let authority_end = rest.find('/').unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if authority.is_empty() {
            return Err(RemoteOpenError::UnsupportedScheme);
        }
        if authority.contains('@') {
            return Err(RemoteOpenError::EmbeddedCredentials);
        }
        let host = authority
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or(authority);
        if host.is_empty() {
            return Err(RemoteOpenError::UnsupportedScheme);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn ip(v: &str) -> IpAddr {
        v.parse().unwrap()
    }

    #[test]
    fn deny_policy_blocks_private_and_link_local() {
        let policy = SshDenyPolicy::new(&[]);
        for addr in [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.10.1",
            "224.0.0.1",
            "0.0.0.0",
            "100.64.0.1",
            "::1",
            "fe80::1",
            "fc00::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(policy.is_denied(ip(addr)), "{addr} should be denied");
        }
        for addr in ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
            assert!(!policy.is_denied(ip(addr)), "{addr} should be allowed");
        }
    }

    #[test]
    fn configured_internal_ranges_are_denied() {
        let policy = SshDenyPolicy::new(&["192.0.2.0/24".to_string(), "2001:db8::/32".to_string()]);
        assert!(policy.is_denied(ip("192.0.2.44")));
        assert!(policy.is_denied(ip("2001:db8::1")));
        assert!(policy.is_denied(ip("192.0.2.255")));
        assert!(!policy.is_denied(ip("192.0.3.44")));
        assert!(!policy.is_denied(ip("93.184.216.34")));
    }

    #[test]
    fn url_validation_rejects_non_https_and_credentials() {
        assert!(SshDenyPolicy::validate_url("https://example.com/a.png").is_ok());
        assert_eq!(
            SshDenyPolicy::validate_url("http://example.com/a.png"),
            Err(RemoteOpenError::UnsupportedScheme)
        );
        assert_eq!(
            SshDenyPolicy::validate_url("https://user:pass@example.com/a.png"),
            Err(RemoteOpenError::EmbeddedCredentials)
        );
        assert_eq!(
            SshDenyPolicy::validate_url("https://"),
            Err(RemoteOpenError::UnsupportedScheme)
        );
    }
}
