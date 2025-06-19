export interface ApiResponse<T> {
  status: string;
  message: string;
  data?: T;
}

export interface TokensInterface {
  accessToken: string;
  refreshToken: string;
}

export interface WebhookData {
  hash_trans: string;
  amount_for_pay: string;
  method_pay: string;
  status: string;
  order_id: string;
  amount: string;
  signature: string;
}
