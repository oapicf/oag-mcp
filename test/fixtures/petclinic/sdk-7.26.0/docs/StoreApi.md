# StoreApi

All URIs are relative to *http://127.0.0.1:4010/v1*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**getExternalDocs**](StoreApi.md#getexternaldocs) | **GET** /external/docs | Fetch documentation that redirects to another host |
| [**getStoreInventory**](StoreApi.md#getstoreinventory) | **GET** /store/inventory | Store inventory counts |



## getExternalDocs

> object getExternalDocs()

Fetch documentation that redirects to another host

### Example

```ts
import {
  Configuration,
  StoreApi,
} from 'petclinic-sdk';
import type { GetExternalDocsRequest } from 'petclinic-sdk';

async function example() {
  console.log("🚀 Testing petclinic-sdk SDK...");
  const api = new StoreApi();

  try {
    const data = await api.getExternalDocs();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

**object**

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Docs |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getStoreInventory

> { [key: string]: number; } getStoreInventory()

Store inventory counts

Returns a map of product code to quantity in stock.

### Example

```ts
import {
  Configuration,
  StoreApi,
} from 'petclinic-sdk';
import type { GetStoreInventoryRequest } from 'petclinic-sdk';

async function example() {
  console.log("🚀 Testing petclinic-sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: bearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new StoreApi(config);

  try {
    const data = await api.getStoreInventory();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

**{ [key: string]: number; }**

### Authorization

[bearerAuth](../README.md#bearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Inventory |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

