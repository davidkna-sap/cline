import { fetchSapAiCoreToken } from "@cline/llms"
import axios from "axios"
import { fetch, getAxiosSettings } from "@/shared/net"
import { SapAiCoreModelDeployment, SapAiCoreModelsRequest, SapAiCoreModelsResponse } from "@/shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

interface Deployment {
	id: string
	name: string
}

/**
 * Fetches deployments and orchestration availability from SAP AI Core deployments
 * @param accessToken Access token for authentication
 * @param baseUrl SAP AI Core base URL
 * @param resourceGroup SAP AI Core resource group
 * @returns Promise<{deployments: Deployment[], orchestrationAvailable: boolean}> Deployments and orchestration availability
 */
async function fetchAiCoreDeploymentsAndOrchestration(
	accessToken: string,
	baseUrl: string,
	resourceGroup: string,
): Promise<{ deployments: Deployment[]; orchestrationAvailable: boolean }> {
	if (!accessToken) {
		return { deployments: [], orchestrationAvailable: false }
	}

	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"AI-Resource-Group": resourceGroup || "default",
		"Content-Type": "application/json",
		"AI-Client-Type": "Cline",
	}

	const url = `${baseUrl}/v2/lm/deployments?$top=10000&$skip=0`

	try {
		const response = await axios.get(url, { headers, ...getAxiosSettings() })
		const allDeployments = response.data.resources

		// Filter running deployments
		const runningDeployments = allDeployments.filter((deployment: any) => deployment.targetStatus === "RUNNING")

		// Check for orchestration deployment
		const orchestrationAvailable = runningDeployments.some((deployment: any) => deployment.scenarioId === "orchestration")

		// Extract deployments with model names and IDs
		const deployments = runningDeployments
			.map((deployment: any) => {
				const model = deployment.details?.resources?.backend_details?.model
				if (!model?.name || !model?.version) {
					return null // Skip this row
				}
				return {
					id: deployment.id,
					name: `${model.name}:${model.version}`,
				}
			})
			.filter((deployment: any) => deployment !== null)

		return { deployments, orchestrationAvailable }
	} catch (error) {
		Logger.error("Error fetching deployments:", error)
		throw new Error("Failed to fetch deployments")
	}
}

/**
 * Fetches available models from SAP AI Core deployments and orchestration availability
 * @param controller The controller instance
 * @param request The request containing SAP AI Core configuration
 * @returns SapAiCoreModelsResponse with deployments and orchestration availability
 */
export async function getSapAiCoreModels(
	controller: Controller,
	request: SapAiCoreModelsRequest,
): Promise<SapAiCoreModelsResponse> {
	try {
		// Check if required configuration is provided
		if (!request.clientId || !request.clientSecret || !request.tokenUrl || !request.baseUrl) {
			// Return empty response if configuration is incomplete
			return SapAiCoreModelsResponse.create({
				deployments: [],
				orchestrationAvailable: false,
			})
		}

		const token = await fetchSapAiCoreToken(
			{
				clientId: request.clientId,
				clientSecret: request.clientSecret,
				tokenUrl: request.tokenUrl,
			},
			{ fetch },
		)
		const { deployments, orchestrationAvailable } = await fetchAiCoreDeploymentsAndOrchestration(
			token.value,
			request.baseUrl,
			request.resourceGroup,
		)

		// Create model-deployment pairs
		const modelDeployments = deployments
			.map((deployment) => {
				const modelName = deployment.name.split(":")[0].toLowerCase()
				return SapAiCoreModelDeployment.create({
					modelName: modelName,
					deploymentId: deployment.id,
				})
			})
			.sort((a, b) => a.modelName.localeCompare(b.modelName))

		return SapAiCoreModelsResponse.create({
			deployments: modelDeployments,
			orchestrationAvailable,
		})
	} catch (error) {
		Logger.error("Error fetching SAP AI Core models:", error)
		return SapAiCoreModelsResponse.create({
			deployments: [],
			orchestrationAvailable: false,
		})
	}
}
