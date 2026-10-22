# AdminApi

All URIs are relative to *http://127.0.0.1:4010/v1*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**deletePet**](AdminApi.md#deletepet) | **DELETE** /pets/{petId} | Delete a pet record |
| [**healthGet**](AdminApi.md#healthget) | **GET** /health | Health check without an operationId |
| [**slowEndpoint**](AdminApi.md#slowendpoint) | **GET** /slow | Responds after a delay |



## deletePet

> deletePet(petId)

Delete a pet record

Permanently deletes a pet. Requires HTTP Basic credentials of a clinic administrator.

### Example

```ts
import {
  Configuration,
  AdminApi,
} from 'petclinic-sdk';
import type { DeletePetRequest } from 'petclinic-sdk';

async function example() {
  console.log("🚀 Testing petclinic-sdk SDK...");
  const config = new Configuration({ 
    // To configure HTTP basic authorization: adminBasic
    username: "YOUR USERNAME",
    password: "YOUR PASSWORD",
  });
  const api = new AdminApi(config);

  const body = {
    // number | Identifier of the pet
    petId: 1,
  } satisfies DeletePetRequest;

  try {
    const data = await api.deletePet(body);
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
| **petId** | `number` | Identifier of the pet | [Defaults to `undefined`] |

### Return type

`void` (Empty response body)

### Authorization

[adminBasic](../README.md#adminBasic)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **204** | Deleted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## healthGet

> Health healthGet()

Health check without an operationId

### Example

```ts
import {
  Configuration,
  AdminApi,
} from 'petclinic-sdk';
import type { HealthGetRequest } from 'petclinic-sdk';

async function example() {
  console.log("🚀 Testing petclinic-sdk SDK...");
  const api = new AdminApi();

  try {
    const data = await api.healthGet();
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

[**Health**](Health.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Health |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## slowEndpoint

> Health slowEndpoint(delayMs)

Responds after a delay

### Example

```ts
import {
  Configuration,
  AdminApi,
} from 'petclinic-sdk';
import type { SlowEndpointRequest } from 'petclinic-sdk';

async function example() {
  console.log("🚀 Testing petclinic-sdk SDK...");
  const api = new AdminApi();

  const body = {
    // number (optional)
    delayMs: 56,
  } satisfies SlowEndpointRequest;

  try {
    const data = await api.slowEndpoint(body);
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
| **delayMs** | `number` |  | [Optional] [Defaults to `undefined`] |

### Return type

[**Health**](Health.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Done |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

