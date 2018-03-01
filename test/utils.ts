
/**
 * Marshall any job payload to google.protobuf.Any
 * Bytes are encoded in base 64
 * @param payload
 */
export function marshallPayload(payload: any): any {
  const stringified = JSON.stringify(payload);
  return {
    type_url: '',
    value: Buffer.from(stringified).toString('base64')
  };
}

/**
 * Unmarshall a job payload.
 * @param payload
 */
export function unmarshallPayload(payload: any): any {
  if (payload.value)  {
    const decoded = Buffer.from(payload.value, 'base64').toString();
    return JSON.parse(decoded);
  }
  return {};
}
