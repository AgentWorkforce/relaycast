//! Billing client for subscription and usage management.

use crate::client::HttpClient;
use crate::error::Result;
use crate::types::{BillingSubscription, PortalResponse, SubscribeRequest, UsageInfo};

/// Client for billing operations.
pub struct BillingClient<'a> {
    client: &'a HttpClient,
}

impl<'a> BillingClient<'a> {
    /// Create a new billing client.
    pub(crate) fn new(client: &'a HttpClient) -> Self {
        Self { client }
    }

    /// Subscribe to a plan.
    pub async fn subscribe(&self, request: SubscribeRequest) -> Result<BillingSubscription> {
        self.client
            .post("/v1/billing/subscribe", Some(request), None)
            .await
    }

    /// Get the current subscription.
    pub async fn subscription(&self) -> Result<BillingSubscription> {
        self.client
            .get("/v1/billing/subscription", None, None)
            .await
    }

    /// Get usage information.
    pub async fn usage(&self, period: Option<&str>) -> Result<UsageInfo> {
        let query: Vec<(&str, &str)> = period.map(|p| vec![("period", p)]).unwrap_or_default();
        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };
        self.client.get("/v1/billing/usage", query_ref, None).await
    }

    /// Get invoices.
    pub async fn invoices(&self, limit: Option<i32>) -> Result<Vec<serde_json::Value>> {
        let limit_str = limit.map(|l| l.to_string());
        let query: Vec<(&str, &str)> = limit_str
            .as_ref()
            .map(|l| vec![("limit", l.as_str())])
            .unwrap_or_default();
        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };
        self.client
            .get("/v1/billing/invoices", query_ref, None)
            .await
    }

    /// Get the customer portal URL.
    pub async fn portal(&self) -> Result<PortalResponse> {
        self.client
            .post("/v1/billing/portal", None::<()>, None)
            .await
    }
}
