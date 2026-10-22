# OwnersApi

All URIs are relative to *http://127.0.0.1:4010/v1*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**listOwners**](OwnersApi.md#listowners) | **GET** /owners | List owners |



## listOwners

> Array&lt;Owner&gt; listOwners(city)

List owners

Lists pet owners with their contact city.

### Example

```ts
import {
  Configuration,
  OwnersApi,
} from 'petclinic-sdk-variant';
import type { ListOwnersRequest } from 'petclinic-sdk-variant';

async function example() {
  console.log("🚀 Testing petclinic-sdk-variant SDK...");
  const config = new Configuration({ 
    // To configure API key authorization: apiKeyQuery
    apiKey: "YOUR API KEY",
  });
  const api = new OwnersApi(config);

  const body = {
    // string (optional)
    city: Melbourne,
  } satisfies ListOwnersRequest;

  try {
    const data = await api.listOwners(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **city** | `string` |  | [Optional] [Defaults to `undefined`] |

### Return type

[**Array&lt;Owner&gt;**](Owner.md)

### Authorization

[apiKeyQuery](../README.md#apiKeyQuery)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Owners |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

